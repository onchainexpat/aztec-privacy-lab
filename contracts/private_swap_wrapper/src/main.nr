// PrivateSwapWrapper - seed of variant (c).
//
// Variant (c) wants public sender and public receiver but *private* swap
// amounts. The reference AMM bakes amounts into the public reserves delta,
// so we need a commitment layer on top: the caller publishes a Pedersen
// commitment to the swap amount, and later proves (in ZK) that the commitment
// matches a swap that respects x*y=k. This contract ships the commitment
// piece; the curve-respect proof is the research-grade part of phase 1.6.

use aztec::macros::aztec;

#[aztec]
pub contract PrivateSwapWrapper {
    use aztec::macros::functions::external;

    // Pedersen-commit (amount, randomness). The caller keeps `randomness`
    // private; observers only see the returned commitment.
    #[external("private")]
    fn commit_amount(amount: Field, randomness: Field) -> pub Field {
        std::hash::pedersen_hash([amount, randomness])
    }

    // Recompute the commitment for a revealed (amount, randomness) pair so
    // anyone can verify it.
    #[external("utility")]
    unconstrained fn open_commitment(amount: Field, randomness: Field) -> pub Field {
        std::hash::pedersen_hash([amount, randomness])
    }
}
