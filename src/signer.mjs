// SIGNER FACTORY — where the private key comes from.
//
// Two modes, selected by COSMOS_SIGNER (default "local"):
//
//   local   (today, unchanged): the raw key lives in this process, loaded from config.json or the
//           POLYMARKET_PRIVATE_KEY env var. The user runs the bot on their own machine.
//
//   turnkey (Cosmos Cloud): the key lives in a Turnkey secure enclave inside the USER'S OWN
//           sub-organization. We hold only a delegated, policy-limited API key. Every signature is
//           evaluated in-enclave against the policy set in the platform repo
//           (lib/turnkey/policies.ts): only EIP-712, only the Polymarket CTF Exchange domains, only
//           primaryType "Order" or the ClobAuthDomain message, with maker pinned to this user's own
//           funder. We cannot sign a transfer, an approval, a permit, an arbitrary message, or a
//           transaction. See docs/cosmos-cloud-plan.md in the platform repo.
//
// Both modes return a viem-compatible account, so everything downstream (ClobClient,
// createL1Headers, order signing) is identical: clob-client-v2 accepts any signer exposing
// signTypedData/_signTypedData (dist/signing/signer.js:2-3).
//
// The @turnkey/* packages are imported DYNAMICALLY and are optional. A self-hosted bot must keep
// working with them absent, and the live fleet must never gain a hard dependency it does not use.

import { privateKeyToAccount } from "viem/accounts";

export const SIGNER_MODE = (process.env.COSMOS_SIGNER || "local").toLowerCase();

const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`COSMOS_SIGNER=turnkey requires ${name}`);
  return v;
};

/**
 * Returns { account, address, mode }. `account` is a viem account suitable for createWalletClient.
 * Throws with a plain-language message rather than returning a half-configured signer: a bot that
 * cannot sign must fail loudly at boot, never silently trade with the wrong identity.
 */
export async function makeSigner(config) {
  if (SIGNER_MODE === "local") {
    const key = config?.polymarket?.privateKey;
    if (!key) throw new Error("no private key configured (config.polymarket.privateKey)");
    const account = privateKeyToAccount(key);
    return { account, address: account.address, mode: "local" };
  }

  if (SIGNER_MODE === "turnkey") {
    // Delegated access: an API-only, NON-ROOT user inside the end user's sub-organization. The end
    // user is the root of their own sub-org (via passkey), so they can revoke us at any time and we
    // can never approve anything through the root quorum (root bypasses the policy engine).
    const organizationId = need("TURNKEY_SUB_ORG_ID"); // the USER's sub-org, not our parent org
    const signWith = need("TURNKEY_SIGN_WITH");        // the imported key's address
    const apiPublicKey = need("TURNKEY_API_PUBLIC_KEY");
    const apiPrivateKey = need("TURNKEY_API_PRIVATE_KEY");
    const baseUrl = process.env.TURNKEY_BASE_URL || "https://api.turnkey.com";

    let TurnkeyClient, ApiKeyStamper, createAccount;
    try {
      ({ TurnkeyClient } = await import("@turnkey/http"));
      ({ ApiKeyStamper } = await import("@turnkey/api-key-stamper"));
      ({ createAccount } = await import("@turnkey/viem"));
    } catch (e) {
      throw new Error(`COSMOS_SIGNER=turnkey needs @turnkey/http, @turnkey/api-key-stamper and @turnkey/viem installed (${e.message})`);
    }

    const client = new TurnkeyClient({ baseUrl }, new ApiKeyStamper({ apiPublicKey, apiPrivateKey }));
    // createAccount returns a viem LocalAccount whose signTypedData calls Turnkey. Importantly it
    // submits PAYLOAD_ENCODING_EIP712 (the unhashed struct), which is what makes the policy engine
    // able to SEE the order contents. If this ever changed to a pre-computed digest, the enclave
    // would see 32 opaque bytes and the policy could not tell an order from a USDC permit.
    const account = await createAccount({ client, organizationId, signWith });

    if (String(account.address).toLowerCase() !== String(signWith).toLowerCase()) {
      throw new Error(`turnkey signer address mismatch: expected ${signWith}, got ${account.address}`);
    }
    return { account, address: account.address, mode: "turnkey" };
  }

  throw new Error(`unknown COSMOS_SIGNER "${SIGNER_MODE}" (expected "local" or "turnkey")`);
}
