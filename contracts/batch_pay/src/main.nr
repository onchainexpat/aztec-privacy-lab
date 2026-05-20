// BatchPay - nested private composability demo.
//
// Demonstrates Aztec blog feature #3 (private DeFi composability) and #4
// (reduced deposit/withdrawal leakage) in one shot: a SINGLE private
// function call that makes MULTIPLE nested private sub-calls into the
// Token contract, with zero public footprint.
//
// FLOW: the caller invokes pay_two / pay_three. Inside that one private
// function, BatchPay calls Token.transfer_in_private(caller, recipient_i,
// amount_i, nonce_i) once per recipient. transfer_in_private is a
// private->private note operation: it nullifies the caller's balance note
// and creates a recipient balance note, all inside the private kernel.
//
// PRIVACY PROPERTIES (this is the headline):
//   - No public state changes AT ALL. The whole batch lives in the private
//     kernel - observers see a tx landed and some nullifiers/commitments
//     in the global trees, but cannot tell:
//       * who sent (caller hidden in private kernel)
//       * who received (recipients are private note owners)
//       * how much (amounts never leave private notes)
//       * how many recipients (one tx, opaque note set)
//   - Contrast with a Solidity batch payment, where every recipient +
//     amount is a public calldata/event entry.
//
// COMPOSABILITY: BatchPay never holds tokens. It orchestrates the caller's
// own private balance via auto-injected inner authwits (the embedded wallet
// signs the transfer_in_private calls on the caller's behalf, same pattern
// as the games' transfer_to_public fee payments). This is a real nested
// private call stack across two contracts (BatchPay -> Token), written by
// different authors, all private.

use aztec::macros::aztec;

#[aztec]
pub contract BatchPay {
    use aztec::macros::{functions::{external, initializer}, storage::storage};
    use aztec::protocol::address::AztecAddress;
    use aztec::state_vars::PublicImmutable;
    use token::Token;

    #[storage]
    struct Storage<Context> {
        payment_token: PublicImmutable<AztecAddress, Context>,
    }

    #[external("public")]
    #[initializer]
    fn init(payment_token: AztecAddress) {
        self.storage.payment_token.initialize(payment_token);
    }

    // Pay two recipients private amounts in one private tx. Caller's balance
    // notes are spent and recipient notes created inside the private kernel.
    #[external("private")]
    fn pay_two(
        to1: AztecAddress,
        amount1: u128,
        nonce1: Field,
        to2: AztecAddress,
        amount2: u128,
        nonce2: Field,
    ) {
        let from = self.msg_sender();
        let token = self.storage.payment_token.read();
        Token::at(token).transfer_in_private(from, to1, amount1, nonce1).call(self.context);
        Token::at(token).transfer_in_private(from, to2, amount2, nonce2).call(self.context);
    }

    // Pay three recipients in one private tx.
    #[external("private")]
    fn pay_three(
        to1: AztecAddress,
        amount1: u128,
        nonce1: Field,
        to2: AztecAddress,
        amount2: u128,
        nonce2: Field,
        to3: AztecAddress,
        amount3: u128,
        nonce3: Field,
    ) {
        let from = self.msg_sender();
        let token = self.storage.payment_token.read();
        Token::at(token).transfer_in_private(from, to1, amount1, nonce1).call(self.context);
        Token::at(token).transfer_in_private(from, to2, amount2, nonce2).call(self.context);
        Token::at(token).transfer_in_private(from, to3, amount3, nonce3).call(self.context);
    }
}
