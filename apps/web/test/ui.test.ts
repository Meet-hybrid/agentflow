import { describe, expect, it } from "vitest";
import { explorer, short } from "../src/components/ui.tsx";

describe("explorer links", () => {
  it("links testnet data to the testnet explorer only", () => {
    expect(explorer("tx", "abc", "Test SDF Network ; September 2015")).toBe(
      "https://stellar.expert/explorer/testnet/tx/abc",
    );
    expect(explorer("tx", "abc", "Public Global Stellar Network ; September 2015")).toBe(
      "https://stellar.expert/explorer/public/tx/abc",
    );
    expect(explorer("tx", "abc", "Standalone Network ; February 2017")).toBeNull();
  });

  it("shortens long identifiers", () => {
    expect(short("GABCDEFGHIJKLMNOPQRSTUVWXYZ", 4)).toBe("GABC…WXYZ");
    expect(short("short", 4)).toBe("short");
  });
});
