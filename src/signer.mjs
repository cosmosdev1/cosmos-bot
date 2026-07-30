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

// Read at CALL time, not import time (prove-out 2026-07-30): ES module imports are hoisted and
// evaluate before any statement in the importing file, so a tool that sets process.env.COSMOS_SIGNER
// after its imports had the mode silently locked to "local" — which then demanded a raw private key,
// the exact thing hosted mode exists to never touch. A function cannot be captured stale.
export const signerMode = () => (process.env.COSMOS_SIGNER || "local").toLowerCase();

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
  const mode = signerMode();
  if (mode === "local") {
    const key = config?.polymarket?.privateKey;
    if (!key) throw new Error("no private key configured (config.polymarket.privateKey)");
    const account = privateKeyToAccount(key);
    return { account, address: account.address, mode: "local" };
  }

  if (mode === "remote") {
    // COSMOS CLOUD (Option C): no key here. signTypedData POSTs to the platform's /api/cloud/sign,
    // which runs the risk gate, has the delegate initiate, and a SEPARATE approver co-sign. This is
    // the model that keeps a compromised bot container unable to place anything but its own gated,
    // approver-checked orders. See ./remote-signer.mjs.
    const { makeRemoteSigner } = await import("./remote-signer.mjs");
    return makeRemoteSigner(config);
  }

  if (mode === "turnkey") {
    // DANGEROUS FOR HOSTED ACCOUNTS (audit 2026-07-29). This mode calls Turnkey DIRECTLY from the bot
    // with the delegate credential: no risk gate, no idempotency ledger, no approver co-sign, and no
    // per-trade signature cap. Under the two-party order policy its signs can never complete anyway
    // (they park at CONSENSUS_NEEDED); under any single-party policy it can mint many signatures per
    // decision. Hosted custody must use COSMOS_SIGNER=remote, which routes through /api/cloud/sign.
    if (!/^(1|true|yes|on)$/i.test(process.env.COSMOS_ALLOW_DIRECT_TURNKEY || "")) {
      throw new Error("COSMOS_SIGNER=turnkey is disabled: it bypasses the risk gate, the approver and the per-trade signature cap. Use COSMOS_SIGNER=remote (set COSMOS_ALLOW_DIRECT_TURNKEY=1 only for offline testing).");
    }

    // Delegated access: an API-only, NON-ROOT user inside the end user's sub-organization. The end
    // user is the root of their own sub-org (via passkey), so they can revoke us at any time and we
    // can never approve anything through the root quorum (root bypasses the policy engine).
    const organizationId = need("TURNKEY_SUB_ORG_ID"); // the USER's sub-org, not our parent org
    const signWith = need("TURNKEY_SIGN_WITH");        // the imported key's address
    // DEDICATED delegate var names (red-team 2026-07-26): the bot must NEVER read TURNKEY_API_* -
    // those hold the PARENT ROOT key on the platform. Copying platform env into a worker would then
    // ship root custody of every future user into a bot container. Distinct names make that mistake
    // impossible, and the whoami assertion below catches it even if someone mis-sets them.
    const apiPublicKey = need("TURNKEY_DELEGATE_PUBLIC_KEY");
    const apiPrivateKey = need("TURNKEY_DELEGATE_PRIVATE_KEY");
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

    // BOOT ASSERTION (red-team 2026-07-26): refuse to start if this credential belongs to any org
    // other than the configured sub-org. A parent-root key mis-placed here would report the PARENT
    // org id and be rejected, so the bot can never accidentally run with fleet-wide root custody.
    try {
      const who = await client.getWhoami({ organizationId });
      if (String(who.organizationId) !== String(organizationId)) {
        throw new Error(`credential belongs to org ${who.organizationId}, not the configured sub-org ${organizationId} - refusing to start (are these PARENT ROOT creds?)`);
      }
    } catch (e) {
      throw new Error(`turnkey signer identity check failed: ${e?.message || e}`);
    }

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

  throw new Error(`unknown COSMOS_SIGNER "${mode}" (expected "local", "remote", or "turnkey")`);
}
