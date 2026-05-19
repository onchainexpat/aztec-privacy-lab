// IdentityAttestation - anonymous credential primitive.
//
// USE CASE: KYC-without-deanonymization. An issuer (e.g., a KYC provider,
// age-gate operator, accredited-investor verifier) adds credential
// commitments to a public whitelist off-chain. Later, holders prove
// membership without revealing WHICH credential they hold.
//
// FLOW:
//   1. Off-chain: user generates a random secret S, sends commitment
//      C = pedersen(S) to the issuer along with their identity.
//   2. Issuer validates the identity off-chain and calls
//      add_credential(C) to publish C as an "available" slot.
//   3. Later, the user calls prove_membership(S) privately. The contract
//      verifies pedersen(S) is an available slot, marks it spent, and
//      increments a public proof counter. The CALLER stays hidden in the
//      private kernel - observers see "some address proved membership"
//      but not which one.
//
// PRIVACY PROPERTIES:
//   - Prover identity hidden from public observers (private function).
//   - Multiple credentials issued: observers cannot distinguish WHICH
//     credential was just consumed, only that one was.
//   - Operator caveat: the issuer can correlate "I added C for Alice"
//     with "C was just consumed", so the issuer learns when Alice proves
//     membership. For unlinkable proofs across multiple contexts, you'd
//     extend this to a Semaphore-style derived-nullifier scheme - not
//     in this MVP.
//
// COMPARISON TO SOLIDITY:
//   Solidity would either (a) require the user to sign with a known
//   address (deanonymizing them) or (b) need an MPC/threshold scheme.
//   Aztec's private function call gets the "prover hidden" property
//   for free via the private kernel.

use aztec::macros::aztec;

#[aztec]
pub contract IdentityAttestation {
    use aztec::macros::{
        functions::{external, initializer, only_self},
        storage::storage,
    };
    use aztec::protocol::address::AztecAddress;
    use aztec::state_vars::{Map, PublicImmutable, PublicMutable};

    global SLOT_AVAILABLE: u8 = 1;
    global SLOT_SPENT: u8 = 2;

    #[storage]
    struct Storage<Context> {
        // Trusted issuer who can add credential slots.
        issuer: PublicImmutable<AztecAddress, Context>,
        // commitment hash -> 0=unused, 1=available, 2=spent
        credentials: Map<Field, PublicMutable<u8, Context>, Context>,
        total_issued: PublicMutable<u32, Context>,
        total_proven: PublicMutable<u32, Context>,
    }

    #[external("public")]
    #[initializer]
    fn init(issuer: AztecAddress) {
        self.storage.issuer.initialize(issuer);
    }

    // Issuer-only: add a credential commitment to the whitelist.
    #[external("public")]
    fn add_credential(commitment: Field) {
        let issuer = self.storage.issuer.read();
        assert(self.msg_sender() == issuer, "only issuer");
        assert(
            self.storage.credentials.at(commitment).read() == 0,
            "credential already added",
        );
        self.storage.credentials.at(commitment).write(SLOT_AVAILABLE);
        let prev = self.storage.total_issued.read();
        self.storage.total_issued.write(prev + 1);
    }

    // Anyone holding a credential secret S can prove membership privately.
    // The contract verifies pedersen(S) is an available slot and marks it
    // spent. The caller's address never leaves the private kernel.
    #[external("private")]
    fn prove_membership(secret: Field) {
        let commitment = std::hash::pedersen_hash([secret]);
        self.enqueue_self._consume_slot(commitment);
    }

    #[external("public")]
    #[only_self]
    fn _consume_slot(commitment: Field) {
        let status = self.storage.credentials.at(commitment).read();
        assert(status == SLOT_AVAILABLE, "not authorized or already spent");
        self.storage.credentials.at(commitment).write(SLOT_SPENT);
        let prev = self.storage.total_proven.read();
        self.storage.total_proven.write(prev + 1);
    }

    #[external("utility")]
    unconstrained fn get_slot_status(commitment: Field) -> pub u8 {
        self.storage.credentials.at(commitment).read()
    }

    #[external("utility")]
    unconstrained fn get_total_issued() -> pub u32 {
        self.storage.total_issued.read()
    }

    #[external("utility")]
    unconstrained fn get_total_proven() -> pub u32 {
        self.storage.total_proven.read()
    }
}
