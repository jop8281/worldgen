# Decision needed: who pays for a Boat VM (YOS-87)

**Asked of:** the user, via worldgen-27. **Drafted by:** worldgen-79, 2026-10-07. **Blocks:** the YOS-87 acceptance items "reliable wallet/payer attribution" and "full-wallet exposure coverage".

## What is true today

- Every Boat line in `~/.worldgen/costs.jsonl` is attributed to the **key that created or inspected the VM**, as a fingerprint (`sha256:…`). That is provenance, not payer, and `costs` says so.
- WorldGen never tells Boat which organization (wallet) a VM belongs to. The SDK's `create` accepts an `org` (a query parameter or `X-Boat-Org` header), but `boat/client.ts` does not pass it, so each VM lands in whatever organization the key is active in.
- Boat inventory reports a `team` id per VM. Receipts store it as `walletId` with the status `organization_metadata`, `unverified` or `conflicting`. It is Boat's organization metadata, not an invoice.
- Boat's API has per-VM usage at list price (`usage`), organizations (`listOrganizations`, `setActiveOrganization`) and limits per org. It has **no billing or invoice endpoint**, so no option below can verify the actual payer from Boat itself.
- Spend caps are global per machine ledger, across every key and organization.

## Options

### A. Pin one wallet per machine (recommended)

The user names one Boat organization, for example `WORLDGEN_BOAT_ORG=<org id>`. Every `create`, `inventory`, `usage` and `track` call passes it explicitly, and every Boat ledger line records it as `walletId`. Provisioning refuses when the variable is unset. Full-wallet coverage then means tracking every owner VM in that one organization (`sandbox track`), which is complete for VMs this machine can see.

- **For:** deterministic. VMs can no longer land in an unexpected organization. The caps the user sets are the caps of the wallet they named. Small: one variable, and the `org` parameter already exists on every call.
- **Against:** one wallet per machine. Spend under another organization on the same machine is visible only as foreign inventory, not under the caps. It is still organization metadata, not a verified invoice.

### B. Record each key's active organization as it is used

On first use of a key, resolve its active organization (`me` / `listOrganizations`), append a `key → org` line to the ledger, and attribute that key's VMs to it. Caps could then be set per organization.

- **For:** no configuration. Several keys and organizations on one machine are attributed separately.
- **Against:** the active organization can change (`setActiveOrganization`, or someone else using the dashboard) between a create and its settlement, so attribution can be wrong without any error. More code, and per-organization caps are a new cap kind.

### C. Keep provenance only, and say so

Do not attribute a payer. Keep key fingerprints and Boat's `team` metadata as unverified, keep caps global, and record that YOS-87's payer item is out of scope because Boat exposes no billing API.

- **For:** no work, and nothing claims more than it knows.
- **Against:** YOS-87's acceptance item stays unmet. Costs cannot be split per payer, and a VM may land in an unintended organization.

## What each option changes in code

| | A | B | C |
|---|---|---|---|
| New config | `WORLDGEN_BOAT_ORG` | none | none |
| `boat/client.ts` | pass `org` on create, inventory and usage | resolve the active org per key | none |
| Ledger | `walletId` on Boat lines | `key → org` lines and `walletId` | none |
| Caps | unchanged, scoped to the pinned wallet's VMs | optional per-org caps | unchanged |
| YOS-87 payer item | met, as organization metadata | met, as organization metadata | closed as out of scope |

**Recommendation:** A. It is the smallest change that makes attribution deterministic and stops VMs landing in an unexpected organization. B's silent misattribution, when the active organization changes, is the failure YOS-87 exists to prevent. Whichever is chosen, it can't be a verified invoice until Boat offers billing data.
