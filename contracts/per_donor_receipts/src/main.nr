// PerDonorReceipts - launchpad variant lp3.
//
// Public per-contributor receipts with hashed identities. Each donation:
//   1) moves the donor's private balance into the contract's public pot
//      (auditable running total like lp2)
//   2) writes a public receipt slot keyed by hash(donor, salt) -> amount
//
// Anyone can read every receipt and the running total. Linking a receipt to a
// wallet requires the donor's salt - kept private in their tab. Donors can
// later prove participation by revealing (donor_addr, salt) to a verifier.

use aztec::macros::aztec;

#[aztec]
pub contract PerDonorReceipts {
    use aztec::macros::{
        functions::{external, initializer, only_self},
        storage::storage,
    };
    use aztec::protocol::address::AztecAddress;
    use aztec::protocol::traits::ToField;
    use aztec::state_vars::{Map, PublicImmutable, PublicMutable};
    use token::Token;

    #[storage]
    struct Storage<Context> {
        donation_token: PublicImmutable<AztecAddress, Context>,
        operator: PublicImmutable<AztecAddress, Context>,
        total_raised: PublicMutable<u128, Context>,
        // hash(donor, salt) -> cumulative receipt amount
        receipts: Map<Field, PublicMutable<u128, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn init(donation_token: AztecAddress, operator: AztecAddress) {
        self.storage.donation_token.initialize(donation_token);
        self.storage.operator.initialize(operator);
    }

    #[external("private")]
    fn donate_with_receipt(amount: u128, salt: Field, authwit_nonce: Field) {
        let donor = self.msg_sender();
        let token = self.storage.donation_token.read();
        Token::at(token)
            .transfer_to_public(donor, self.address, amount, authwit_nonce)
            .call(self.context);

        let receipt_key = std::hash::pedersen_hash([donor.to_field(), salt]);
        self.enqueue_self._record_receipt(receipt_key, amount);
    }

    #[external("public")]
    #[only_self]
    fn _record_receipt(receipt_key: Field, amount: u128) {
        let prev_total = self.storage.total_raised.read();
        self.storage.total_raised.write(prev_total + amount);
        let prev_receipt = self.storage.receipts.at(receipt_key).read();
        self.storage.receipts.at(receipt_key).write(prev_receipt + amount);
    }

    #[external("utility")]
    unconstrained fn get_total_raised() -> pub u128 {
        self.storage.total_raised.read()
    }

    #[external("utility")]
    unconstrained fn get_receipt(receipt_key: Field) -> pub u128 {
        self.storage.receipts.at(receipt_key).read()
    }
}
