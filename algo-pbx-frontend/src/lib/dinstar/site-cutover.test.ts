import { describe, expect, it } from "vitest";
import { cutoverToSite } from "./site-cutover";

// cutoverToSite calls real setSetting/provisionDinstarConfig/db.auditLog —
// not DB-free like most of this repo's other lib tests, same accepted
// convention as provisionDinstarConfig itself (see that function's own
// header comment: routes/orchestrators touching real infra aren't
// unit-testable beyond their extracted pure decision logic). The one piece
// that IS pure and worth testing without any infra is the null-tunnelIp
// guard — it must return a typed failure and never call anything else.
describe("cutoverToSite", () => {
  it("refuses a site with no tunnel IP, without touching settings/AMI/DB", async () => {
    const result = await cutoverToSite({ id: "site1", tunnelIp: null, gatewayLanIp: "192.168.11.1" }, "actor1");
    expect(result.ok).toBe(false);
    expect(result.settingUpdated).toBe(false);
    expect(result.error).toMatch(/no tunnel ip/i);
  });

  it("refuses a site with an empty-string tunnel IP the same way", async () => {
    const result = await cutoverToSite({ id: "site2", tunnelIp: "", gatewayLanIp: "192.168.11.1" }, "actor1");
    expect(result.ok).toBe(false);
    expect(result.settingUpdated).toBe(false);
  });
});
