# amazon_order_proof — zkEmail PoC for trustless goods escrow

This is the **trustless upgrade path** for `contracts/goods_escrow` (the
zkp2p-style P2P goods escrow). Instead of a trusted `attestor` validating that
a fulfiller bought + received an Amazon item, the fulfiller would submit a
**zkEmail proof** that a Noir circuit (or an on-chain verifier) checks.

## What `src/main.nr` does

Using the [`zkemail.nr`](https://github.com/zkemail/zkemail.nr) library it:

1. Verifies an Amazon confirmation email's **DKIM RSA-2048 signature** over the
   header (`pubkey.verify_dkim_signature`) — proving the email genuinely came
   from the domain that controls the DKIM key.
2. Extracts the **From address** (`get_email_address`) so app logic can assert
   the sender domain is `amazon.com`.
3. Returns a **nullifier** = `pedersen_hash(signature)` so the same email can't
   fulfill two escrows (mirrors zkp2p's payment nullifier).

In the escrow flow: order-confirmation email → `attest_purchase`; delivery
-confirmation email → `attest_delivery`. The order id / item would be matched
by additionally constraining the subject/body with `constrain_header_field` +
`mask_text`.

## Status: written, not compiling against the Aztec toolchain

`zkemail.nr` targets **vanilla Noir**, and its latest release (`v2.0.0`) does
**not** typecheck under the Aztec-bundled `nargo` (`1.0.0-beta.19`):

- `zkemail v2.0.0` lib code + its `tests/mod.nr` use `BoundedVec.len` as a
  field (now private — must be `.len()`), and re-exports `KEY_LIMBS_2048` /
  `MAX_EMAIL_ADDRESS_LENGTH` as private.
- the transitive `noir_base64 v0.4.0` dep uses removed constructs (`u1`,
  `u8`-indexed arrays) and pre-private `to_be_radix`.
- older tags (`v1.4.0`) target even older Noir (`u1` everywhere).

This confirms the upstream status — zkemail.nr's README lists "Aztec Contract
tests" as a TODO. The library + the Aztec toolchain are on diverging Noir
release trains.

## To actually run it

1. Install a `nargo` version aligned with `zkemail.nr v2.0.0`'s pinned deps via
   [`noirup`](https://github.com/noir-lang/noirup) (an earlier `1.0.0-beta`
   where `BoundedVec.len` was public), separate from the Aztec toolchain.
2. Get a genuine Amazon `.eml` (order or delivery confirmation) and run it
   through the [zkEmail JS SDK](https://github.com/zkemail/zk-email-verify) to
   generate `Prover.toml` inputs (header bytes, RSA modulus/redc limbs,
   signature limbs, From-field byte sequences).
3. `nargo execute` to generate the witness, then prove with `bb`.

The on-chain-verifiable half (this circuit) is the contribution; the input
generation is off-chain tooling. Wiring the resulting proof into an Aztec
contract awaits zkemail.nr's Aztec integration landing upstream.
