// Rewards - Merkl-style private rewards distribution.
//
// USE CASE: an app incentivizes usage by paying out reward tokens. It computes
// (recipient, amount) entitlements off-chain from on-chain activity, builds a
// Merkle tree of those leaves, and publishes only the ROOT. A single 32-byte
// root commits to thousands of recipients (vs one commitment per recipient in
// the payroll variant). Users claim by proving Merkle inclusion privately.
//
// FLOW:
//   1. Operator funds the pool + publish_root(root) for the current period.
//   2. A user claims with claim_public / claim_private, supplying their amount,
//      the period, and a Merkle (leaf_index, sibling_path). The contract
//      recomputes leaf = poseidon2(claimant, amount, period) from the HIDDEN
//      caller, verifies it hashes up to the published root, marks the leaf
//      claimed (one claim per leaf per period), and releases the reward.
//   3. advance_period lets the operator run recurring campaigns; the same
//      (recipient, amount) becomes a fresh leaf each period.
//
// TWO PAYOUT MODES (the privacy axis):
//   - claim_public: pays via transfer_in_public. Amount + recipient are public
//     at claim; the claimant's eligible identity stays hidden in the private
//     kernel, and the anonymity set is the whole tree.
//   - claim_private: pays via transfer_to_private. The RECIPIENT is hidden in a
//     partial note; the amount is still public (the token's public balance move
//     reveals it). Strictly more private than claim_public on the recipient.
//
// HONEST BOUNDARY: hiding the payout AMOUNT is NOT possible here - the contract
// custodies funds in public balance (the established Aztec pattern), so every
// release moves a visible amount out of public state. Amount-private payout
// would need contract-owned private notes / supply-hiding (research-grade).

use aztec::macros::aztec;

#[aztec]
pub contract Rewards {
    use aztec::macros::{
        functions::{external, initializer, only_self},
        storage::storage,
    };
    use aztec::protocol::address::AztecAddress;
    use aztec::protocol::hash::poseidon2_hash;
    use aztec::protocol::merkle_tree::root::root_from_sibling_path;
    use aztec::protocol::traits::ToField;
    use aztec::state_vars::{Map, PublicImmutable, PublicMutable};
    use token::Token;

    global TREE_DEPTH: u32 = 4; // up to 16 leaves per campaign in this demo
    global DEMO_REWARD: u128 = 50; // fixed payout for the permissionless demo claim

    #[storage]
    struct Storage<Context> {
        payment_token: PublicImmutable<AztecAddress, Context>,
        operator: PublicImmutable<AztecAddress, Context>,
        // Current campaign Merkle root (poseidon2 tree of (recipient, amount, period) leaves).
        root: PublicMutable<Field, Context>,
        period: PublicMutable<u64, Context>,
        total_claimed: PublicMutable<u32, Context>,
        // leaf -> claimed. One claim per leaf (per period, since period is in the leaf).
        claimed: Map<Field, PublicMutable<bool, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn init(payment_token: AztecAddress, operator: AztecAddress) {
        self.storage.payment_token.initialize(payment_token);
        self.storage.operator.initialize(operator);
    }

    // Operator publishes / replaces the campaign root.
    #[external("public")]
    fn publish_root(new_root: Field) {
        assert(self.msg_sender() == self.storage.operator.read(), "only operator");
        self.storage.root.write(new_root);
    }

    // Operator advances to the next campaign period.
    #[external("public")]
    fn advance_period() {
        assert(self.msg_sender() == self.storage.operator.read(), "only operator");
        let prev = self.storage.period.read();
        self.storage.period.write(prev + 1);
    }

    // Claim with a PUBLIC payout. The caller proves Merkle inclusion of
    // leaf = poseidon2(caller, amount, period); funds are released to `recipient`
    // (which may be an unlinkable burner). Caller identity stays in the kernel.
    #[external("private")]
    fn claim_public(
        amount: u128,
        period: u64,
        leaf_index: Field,
        sibling_path: [Field; TREE_DEPTH],
        recipient: AztecAddress,
    ) {
        let claimant = self.msg_sender();
        let leaf = poseidon2_hash([claimant.to_field(), amount as Field, period as Field]);
        let candidate_root = root_from_sibling_path(leaf, leaf_index, sibling_path);
        self.enqueue_self._settle_public(leaf, candidate_root, period, recipient, amount);
    }

    #[external("public")]
    #[only_self]
    fn _settle_public(
        leaf: Field,
        candidate_root: Field,
        period: u64,
        recipient: AztecAddress,
        amount: u128,
    ) {
        assert(candidate_root == self.storage.root.read(), "bad merkle proof");
        assert(period == self.storage.period.read(), "wrong period");
        assert(!self.storage.claimed.at(leaf).read(), "already claimed");
        self.storage.claimed.at(leaf).write(true);
        let token = self.storage.payment_token.read();
        Token::at(token).transfer_in_public(self.address, recipient, amount, 0).call(self.context);
        let prev = self.storage.total_claimed.read();
        self.storage.total_claimed.write(prev + 1);
    }

    // Claim with a PRIVATE-RECIPIENT payout. Same inclusion proof, but funds are
    // moved into a partial note for `recipient` via transfer_to_private, so the
    // recipient is hidden. The amount is still public (the token's public
    // balance move reveals it).
    #[external("private")]
    fn claim_private(
        amount: u128,
        period: u64,
        leaf_index: Field,
        sibling_path: [Field; TREE_DEPTH],
        recipient: AztecAddress,
    ) {
        let claimant = self.msg_sender();
        let leaf = poseidon2_hash([claimant.to_field(), amount as Field, period as Field]);
        let candidate_root = root_from_sibling_path(leaf, leaf_index, sibling_path);
        let token = self.storage.payment_token.read();
        Token::at(token).transfer_to_private(recipient, amount).call(self.context);
        self.enqueue_self._settle_private(leaf, candidate_root, period);
    }

    #[external("public")]
    #[only_self]
    fn _settle_private(leaf: Field, candidate_root: Field, period: u64) {
        assert(candidate_root == self.storage.root.read(), "bad merkle proof");
        assert(period == self.storage.period.read(), "wrong period");
        assert(!self.storage.claimed.at(leaf).read(), "already claimed");
        self.storage.claimed.at(leaf).write(true);
        let prev = self.storage.total_claimed.read();
        self.storage.total_claimed.write(prev + 1);
    }

    // DEMO-ONLY: permissionless private claim so a shared-testnet visitor can
    // experience the core privacy property without being pre-registered in a
    // Merkle campaign. The caller stays hidden in the private kernel; a fixed
    // DEMO_REWARD is paid to `recipient` (use a fresh address to keep it
    // unlinkable). The real Merkle-inclusion flow (claim_public/claim_private)
    // is unchanged and is exercised interactively on the sandbox. Repeat-
    // claimable with a small fixed amount; the pool is operator-refillable.
    #[external("private")]
    fn demo_claim(recipient: AztecAddress) {
        self.enqueue_self._demo_pay(recipient);
    }

    #[external("public")]
    #[only_self]
    fn _demo_pay(recipient: AztecAddress) {
        let token = self.storage.payment_token.read();
        Token::at(token).transfer_in_public(self.address, recipient, DEMO_REWARD, 0).call(
            self.context,
        );
        let prev = self.storage.total_claimed.read();
        self.storage.total_claimed.write(prev + 1);
    }

    #[external("utility")]
    unconstrained fn get_root() -> pub Field {
        self.storage.root.read()
    }

    #[external("utility")]
    unconstrained fn get_period() -> pub u64 {
        self.storage.period.read()
    }

    #[external("utility")]
    unconstrained fn get_total_claimed() -> pub u32 {
        self.storage.total_claimed.read()
    }

    #[external("utility")]
    unconstrained fn is_claimed(leaf: Field) -> pub bool {
        self.storage.claimed.at(leaf).read()
    }
}
