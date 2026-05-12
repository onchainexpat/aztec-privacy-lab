/**
 * Generates a fresh Schnorr account secret + salt + signing key for testnet
 * deploy. Prints export lines you can paste into a .env or shell.
 *
 *   npm run testnet:generate-key
 *
 * Save these somewhere safe — the SponsoredFPC pays gas, but you still need
 * the secret to use the deployed contracts later.
 */
import { Fr, Fq } from '@aztec/aztec.js/fields'

function main() {
  const secret = Fr.random()
  const salt = Fr.random()
  const signing = Fq.random()
  // eslint-disable-next-line no-console
  console.log(`export TESTNET_SECRET=${secret.toString()}`)
  // eslint-disable-next-line no-console
  console.log(`export TESTNET_SALT=${salt.toString()}`)
  // eslint-disable-next-line no-console
  console.log(`export TESTNET_SIGNING=${signing.toString()}`)
}

main()
