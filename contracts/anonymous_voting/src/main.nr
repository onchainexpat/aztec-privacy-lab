// AnonymousVoting - eligibility-gated, fully anonymous voting.
//
// Composes two privacy primitives:
//   - Eligibility (like the identity-attestation whitelist): the operator
//     publishes a Merkle root over the eligible voters' credential commitments
//     (leaf = poseidon2([secret])). To vote, a holder proves their commitment
//     is in the set via an in-circuit Merkle inclusion proof -- WITHOUT
//     revealing which leaf, so the voter is anonymous within the whole
//     eligible set.
//   - One-vote-each: a nullifier derived from the credential secret
//     (poseidon2([secret, DOMAIN])) is recorded publicly. It's opaque (can't be
//     reversed to the secret or linked to a person) but prevents the same
//     credential voting twice.
//
// The vote runs in a private function (the voter never appears in public
// state); only the candidate's public tally ticks up. Observers learn "an
// eligible voter chose candidate X" - not who, and not which credential.
//
// DEMO path: demo_vote lets a shared-testnet visitor (who isn't pre-registered
// in the eligible set) experience the private vote anyway, using a per-address
// SingleUseClaim nullifier (one vote per address, voter hidden behind their
// app-siloed nullifier key). The real eligibility-gated `vote` is exercised
// interactively on the sandbox.

use aztec::macros::aztec;

#[aztec]
pub contract AnonymousVoting {
    use aztec::macros::{
        functions::{external, initializer, only_self},
        storage::storage,
    };
    use aztec::protocol::address::AztecAddress;
    use aztec::protocol::hash::poseidon2_hash;
    use aztec::protocol::merkle_tree::root::root_from_sibling_path;
    use aztec::state_vars::{Map, Owned, PublicImmutable, PublicMutable, SingleUseClaim};

    global TREE_DEPTH: u32 = 4; // up to 16 eligible voters in this demo
    global NULLIFIER_DOMAIN: Field = 0x564f5445; // "VOTE"

    #[storage]
    struct Storage<Context> {
        operator: PublicImmutable<AztecAddress, Context>,
        num_candidates: PublicImmutable<u32, Context>,
        // Merkle root over eligible credential commitments (poseidon2([secret])).
        eligible_root: PublicMutable<Field, Context>,
        // candidate -> public tally.
        tally: Map<Field, PublicMutable<u32, Context>, Context>,
        total_votes: PublicMutable<u32, Context>,
        // vote nullifier (poseidon2([secret, DOMAIN])) -> voted.
        voted: Map<Field, PublicMutable<bool, Context>, Context>,
        // Per-address single-use claim for the permissionless demo vote.
        demo_claims: Owned<SingleUseClaim<Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn init(operator: AztecAddress, num_candidates: u32) {
        self.storage.operator.initialize(operator);
        self.storage.num_candidates.initialize(num_candidates);
    }

    // Operator publishes / replaces the eligible-voter Merkle root.
    #[external("public")]
    fn publish_eligible_root(new_root: Field) {
        assert(self.msg_sender() == self.storage.operator.read(), "only operator");
        self.storage.eligible_root.write(new_root);
    }

    // Eligibility-gated anonymous vote. The caller proves their credential
    // commitment is in the eligible set (Merkle inclusion) and emits a
    // per-credential nullifier; the caller never appears in public state.
    #[external("private")]
    fn vote(
        secret: Field,
        leaf_index: Field,
        sibling_path: [Field; TREE_DEPTH],
        candidate: Field,
    ) {
        let leaf = poseidon2_hash([secret]);
        let candidate_root = root_from_sibling_path(leaf, leaf_index, sibling_path);
        let nullifier = poseidon2_hash([secret, NULLIFIER_DOMAIN]);
        self.enqueue_self._record_vote(candidate_root, nullifier, candidate);
    }

    #[external("public")]
    #[only_self]
    fn _record_vote(candidate_root: Field, nullifier: Field, candidate: Field) {
        assert(candidate_root == self.storage.eligible_root.read(), "not eligible");
        assert((candidate as u32) < self.storage.num_candidates.read(), "bad candidate");
        assert(!self.storage.voted.at(nullifier).read(), "already voted");
        self.storage.voted.at(nullifier).write(true);
        let prev = self.storage.tally.at(candidate).read();
        self.storage.tally.at(candidate).write(prev + 1);
        let tv = self.storage.total_votes.read();
        self.storage.total_votes.write(tv + 1);
    }

    // DEMO: permissionless one-vote-per-address anonymous vote for shared-
    // testnet visitors who aren't in the eligible set. The SingleUseClaim emits
    // a per-caller app-siloed nullifier (voter stays hidden) and prevents the
    // same address voting twice.
    #[external("private")]
    fn demo_vote(candidate: Field) {
        self.storage.demo_claims.at(self.msg_sender()).claim();
        self.enqueue_self._demo_bump(candidate);
    }

    #[external("public")]
    #[only_self]
    fn _demo_bump(candidate: Field) {
        assert((candidate as u32) < self.storage.num_candidates.read(), "bad candidate");
        let prev = self.storage.tally.at(candidate).read();
        self.storage.tally.at(candidate).write(prev + 1);
        let tv = self.storage.total_votes.read();
        self.storage.total_votes.write(tv + 1);
    }

    #[external("utility")]
    unconstrained fn get_tally(candidate: Field) -> pub u32 {
        self.storage.tally.at(candidate).read()
    }

    #[external("utility")]
    unconstrained fn get_total_votes() -> pub u32 {
        self.storage.total_votes.read()
    }

    #[external("utility")]
    unconstrained fn get_eligible_root() -> pub Field {
        self.storage.eligible_root.read()
    }

    #[external("utility")]
    unconstrained fn is_voted(nullifier: Field) -> pub bool {
        self.storage.voted.at(nullifier).read()
    }
}
