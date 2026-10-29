import { describe, expect, it } from "vitest";
import { catalogPayload } from "../src/jobs/catalog-view.js";

type OptionView = { name: string; uncapped_spend?: string };
type CommandView = { command: string; options: OptionView[] };

function optionsOf(group: string, command: string): OptionView[] {
  const payload = catalogPayload({}, group) as { commands: CommandView[] };
  const found = payload.commands.find((c) => c.command === command);
  if (!found) throw new Error(`${command} not in the catalog`);
  return found.options;
}

describe("multix_catalog: uncapped options", () => {
  it("marks image size and quality options, and leaves the rest unmarked", () => {
    const options = optionsOf("openai", "openai generate");
    const marked = options.filter((o) => o.uncapped_spend).map((o) => o.name);
    expect(marked.sort()).toEqual(["quality", "size"]);
    expect(options.find((o) => o.name === "size")?.uncapped_spend).toBe(
      "with this option, the price per image is not bounded by the server caps",
    );
  });
});
