// GoodsEscrow - zkp2p-style P2P escrow for real-world goods.
//
// USE CASE: "buy me this laptop on Amazon". A buyer locks USDC in escrow
// against a commitment to an item (e.g., hash of an Amazon wishlist URL +
// max price). A fulfiller buys the item in the real world and proves it via
// two attestations - purchase, then delivery. On delivery the escrow
// releases USDC to the fulfiller. If no one fulfills before the deadline,
// the buyer refunds.
//
// MIRRORS ZKP2P: zkp2p's production flow uses an off-chain AttestationService
// that validates payment evidence (via Proxy-TLS/Reclaim, MPC-TLS/TLSNotary,
// zkEmail, or a TEE) and returns an EIP-712-signed PaymentAttestation, which
// an on-chain verifier checks with nullifiers + capping. We model the same
// shape: a trusted `attestor` validates the Amazon evidence off-chain and
// calls attest_purchase / attest_delivery. The order id is nullified so the
// same real-world order can't fulfill two escrows (zkp2p's nullifier).
//
// TRUSTLESS UPGRADE PATH: replace the attestor's manual validation with an
// in-circuit zkEmail (zkemail.nr) proof of Amazon's DKIM-signed order +
// delivery confirmation emails - see contracts/zkemail_poc for a standalone
// proof-of-concept. The escrow logic below is unchanged; only WHO is trusted
// to call the attest_* functions changes (a verifier circuit instead of a
// human attestor).
//
// PRIVACY MODEL:
//   - Buyer creates the escrow via a private function: their L2 identity
//     stays in the private kernel. Public state shows "escrow N: amount X,
//     item commitment Y, status".
//   - The escrow_id = pedersen(buyer, salt), so only the buyer (who knows
//     the salt) can later refund - without revealing they're the buyer.
//   - Fulfiller payout goes to a recipient address chosen at delivery time,
//     unlinkable to any specific real-world fulfiller identity.
//   - The link between the on-chain USDC and the off-chain Amazon order is
//     never published - only an opaque order-id nullifier.

use aztec::macros::aztec;

#[aztec]
pub contract GoodsEscrow {
    use aztec::macros::{
        functions::{external, initializer, only_self},
        storage::storage,
    };
    use aztec::protocol::address::AztecAddress;
    use aztec::protocol::traits::ToField;
    use aztec::state_vars::{Map, PublicImmutable, PublicMutable};
    use token::Token;

    global STATUS_OPEN: u8 = 0;
    global STATUS_PURCHASED: u8 = 1;
    global STATUS_RELEASED: u8 = 2;
    global STATUS_REFUNDED: u8 = 3;

    #[storage]
    struct Storage<Context> {
        payment_token: PublicImmutable<AztecAddress, Context>,
        // Trusted attestation service - stands in for a zkEmail/zkTLS verifier.
        attestor: PublicImmutable<AztecAddress, Context>,

        escrow_count: PublicMutable<u32, Context>,
        released_count: PublicMutable<u32, Context>,

        // Per-escrow public state, keyed by escrow_id = pedersen(buyer, salt).
        amount: Map<Field, PublicMutable<u128, Context>, Context>,
        item_hash: Map<Field, PublicMutable<Field, Context>, Context>,
        status: Map<Field, PublicMutable<u8, Context>, Context>,
        deadline: Map<Field, PublicMutable<u64, Context>, Context>,

        // Order-id nullifiers: a real-world order can fulfill at most one escrow.
        used_orders: Map<Field, PublicMutable<bool, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn init(payment_token: AztecAddress, attestor: AztecAddress) {
        self.storage.payment_token.initialize(payment_token);
        self.storage.attestor.initialize(attestor);
    }

    // Buyer locks `amount` USDC against `item_hash` (commitment to the Amazon
    // wishlist item + max price). escrow_id = pedersen(buyer, salt) so the
    // buyer can refund later without revealing their identity now.
    #[external("private")]
    fn create_escrow(
        amount: u128,
        item_hash: Field,
        deadline: u64,
        salt: Field,
        authwit_nonce: Field,
    ) -> pub Field {
        let buyer = self.msg_sender();
        let token = self.storage.payment_token.read();
        Token::at(token)
            .transfer_to_public(buyer, self.address, amount, authwit_nonce)
            .call(self.context);

        let escrow_id = std::hash::pedersen_hash([buyer.to_field(), salt]);
        self.enqueue_self._open_escrow(escrow_id, amount, item_hash, deadline);
        escrow_id
    }

    #[external("public")]
    #[only_self]
    fn _open_escrow(escrow_id: Field, amount: u128, item_hash: Field, deadline: u64) {
        assert(self.storage.status.at(escrow_id).read() == STATUS_OPEN, "escrow id in use");
        assert(self.storage.amount.at(escrow_id).read() == 0, "escrow id in use");
        self.storage.amount.at(escrow_id).write(amount);
        self.storage.item_hash.at(escrow_id).write(item_hash);
        self.storage.deadline.at(escrow_id).write(deadline);
        // status is already STATUS_OPEN (0) by default
        let prev = self.storage.escrow_count.read();
        self.storage.escrow_count.write(prev + 1);
    }

    // Attestor confirms the fulfiller purchased the item. order_id_hash is a
    // commitment to the real-world order; it's nullified so the same order
    // can't fulfill two escrows. In production this call would be gated by a
    // zkEmail proof of Amazon's order-confirmation email instead of msg_sender.
    #[external("public")]
    fn attest_purchase(escrow_id: Field, order_id_hash: Field) {
        assert(self.msg_sender() == self.storage.attestor.read(), "only attestor");
        assert(self.storage.status.at(escrow_id).read() == STATUS_OPEN, "not open");
        assert(self.storage.amount.at(escrow_id).read() > 0, "no such escrow");
        assert(!self.storage.used_orders.at(order_id_hash).read(), "order already used");
        self.storage.used_orders.at(order_id_hash).write(true);
        self.storage.status.at(escrow_id).write(STATUS_PURCHASED);
    }

    // Attestor confirms delivery and releases USDC to the fulfiller. In
    // production this would be gated by a zkEmail proof of Amazon's delivery
    // confirmation email.
    #[external("public")]
    fn attest_delivery(escrow_id: Field, fulfiller: AztecAddress) {
        assert(self.msg_sender() == self.storage.attestor.read(), "only attestor");
        assert(self.storage.status.at(escrow_id).read() == STATUS_PURCHASED, "not purchased");
        let amount = self.storage.amount.at(escrow_id).read();
        self.storage.status.at(escrow_id).write(STATUS_RELEASED);
        // Release the escrowed USDC from the contract's public balance to the
        // fulfiller. from == self.address so the authwit is auto-satisfied;
        // nonce 0 is fine.
        let token = self.storage.payment_token.read();
        Token::at(token).transfer_in_public(self.address, fulfiller, amount, 0).call(self.context);
        let prev = self.storage.released_count.read();
        self.storage.released_count.write(prev + 1);
    }

    // Buyer reclaims their USDC after the deadline if no fulfiller stepped in
    // (escrow still OPEN). Proves knowledge of the salt to recompute escrow_id,
    // so they refund without revealing they were the buyer publicly.
    #[external("private")]
    fn refund(salt: Field) {
        let buyer = self.msg_sender();
        let escrow_id = std::hash::pedersen_hash([buyer.to_field(), salt]);
        self.enqueue_self._refund(escrow_id, buyer);
    }

    #[external("public")]
    #[only_self]
    fn _refund(escrow_id: Field, buyer: AztecAddress) {
        let now = self.context.timestamp();
        assert(now >= self.storage.deadline.at(escrow_id).read(), "before deadline");
        assert(self.storage.status.at(escrow_id).read() == STATUS_OPEN, "not refundable");
        let amount = self.storage.amount.at(escrow_id).read();
        self.storage.status.at(escrow_id).write(STATUS_REFUNDED);
        let token = self.storage.payment_token.read();
        Token::at(token).transfer_in_public(self.address, buyer, amount, 0).call(self.context);
    }

    #[external("utility")]
    unconstrained fn get_status(escrow_id: Field) -> pub u8 {
        self.storage.status.at(escrow_id).read()
    }

    #[external("utility")]
    unconstrained fn get_amount(escrow_id: Field) -> pub u128 {
        self.storage.amount.at(escrow_id).read()
    }

    #[external("utility")]
    unconstrained fn get_escrow_count() -> pub u32 {
        self.storage.escrow_count.read()
    }

    #[external("utility")]
    unconstrained fn get_released_count() -> pub u32 {
        self.storage.released_count.read()
    }
}
