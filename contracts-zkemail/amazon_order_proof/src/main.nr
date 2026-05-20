// amazon_order_proof - zkEmail proof-of-concept for the goods-escrow
// trustless upgrade path.
//
// PURPOSE: demonstrate that a Noir circuit can verify an Amazon
// confirmation email (DKIM-signed) and extract the sender address +
// produce a replay nullifier, all in-circuit. This is what would replace
// the trusted `attestor` in contracts/goods_escrow: instead of a human
// validating the Amazon evidence, the fulfiller submits a zkEmail proof
// that the circuit (or an on-chain verifier) checks.
//
// This is a STANDALONE nargo binary (not an Aztec contract) - zkemail.nr
// targets vanilla Noir, and its Aztec-contract integration is still on the
// upstream TODO list. It compiles against the zkemail.nr v2.0.0 library
// (which pulls in noir-bignum + noir_rsa + noir_base64 for RSA-2048 DKIM
// verification, ~222k constraints for the full verify).
//
// FLOW the escrow would use:
//   1. Fulfiller receives Amazon "order confirmed" / "delivered" email.
//   2. Off-chain SDK extracts (header, body, DKIM pubkey, signature) and the
//      byte offsets of the From field + address.
//   3. This circuit proves: the DKIM signature is valid, and returns the
//      From address + a nullifier = pedersen(signature).
//   4. App logic asserts the From address domain == amazon.com and the
//      subject/body contains the expected order id, then consumes the
//      nullifier in the escrow so one email fulfills at most one escrow.
//
// To run a real proof you need a genuine Amazon .eml processed by the
// zkemail JS SDK to generate Prover.toml inputs (header bytes, RSA limbs,
// signature limbs, sequences). The circuit below is the on-chain-verifiable
// half; the input generation is off-chain tooling.

use std::{collections::bounded_vec::BoundedVec, hash::pedersen_hash};
use zkemail::{
    dkim::RSAPubkey,
    headers::email_address::get_email_address,
    KEY_LIMBS_2048,
    MAX_EMAIL_ADDRESS_LENGTH,
    Sequence,
};

global MAX_EMAIL_HEADER_LENGTH: u32 = 512;

/**
 * Verify an Amazon confirmation email's DKIM signature and extract the
 * sender address + a replay nullifier.
 *
 * @param header - email header, 0-padded to MAX_EMAIL_HEADER_LENGTH
 * @param pubkey - Amazon's DKIM RSA-2048 public key (modulus + redc param)
 * @param signature - the DKIM RSA signature
 * @param from_header_sequence - index+length of the "From" header field
 * @param from_address_sequence - index+length of the email address within it
 * @return -
 *   0: ([pubkey_hash_0, pubkey_hash_1]) - root-of-trust on the DKIM key
 *   1: email_nullifier = pedersen(signature) - one email, one fulfillment
 *   2: the extracted From address (app asserts domain == amazon.com)
 */
fn main(
    header: BoundedVec<u8, MAX_EMAIL_HEADER_LENGTH>,
    pubkey: RSAPubkey<KEY_LIMBS_2048>,
    signature: [Field; KEY_LIMBS_2048],
    from_header_sequence: Sequence,
    from_address_sequence: Sequence,
) -> pub ([Field; 2], Field, BoundedVec<u8, MAX_EMAIL_ADDRESS_LENGTH>) {
    assert(header.len() <= MAX_EMAIL_HEADER_LENGTH);

    // Verify the DKIM signature over the header (proves the email genuinely
    // came from the sender domain that controls the DKIM key).
    pubkey.verify_dkim_signature(header, signature);

    // Extract the From address so app logic can assert it's an Amazon sender.
    let from = comptime { "from".as_bytes() };
    let from_address =
        get_email_address(header, from_header_sequence, from_address_sequence, from);

    // Nullifier binds the proof to this specific email - prevents replaying
    // the same Amazon order against multiple escrows.
    let email_nullifier = pedersen_hash(signature);
    let pubkey_hash = pubkey.hash();

    ([pubkey_hash[0], pubkey_hash[1]], email_nullifier, from_address)
}
