/**
 * Tool input schemas that keep the JSON Schema published to clients stable:
 * a closed draft-07 object (`additionalProperties: false`), as served before
 * the move to MCP SDK 2.x, whose zod 4 conversion would otherwise emit an
 * open 2020-12 object. Validation is unchanged: zod checks the arguments and
 * strips unknown keys.
 */

import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod";

type JsonObject = Record<string, unknown>;

/** Drop the `propertyNames: { type: "string" }` zod 4 adds to records (JSON keys are always strings). */
function withoutStringPropertyNames(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutStringPropertyNames);
  if (node === null || typeof node !== "object") return node;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node as JsonObject)) {
    const names = value as JsonObject | undefined;
    if (key === "propertyNames" && names?.type === "string" && Object.keys(names).length === 1) {
      continue;
    }
    out[key] = withoutStringPropertyNames(value);
  }
  return out;
}

export function toolInput<Shape extends z.ZodRawShape>(
  shape: Shape,
): StandardSchemaWithJSON<z.input<z.ZodObject<Shape>>, z.output<z.ZodObject<Shape>>> {
  const schema = z.object(shape);
  let json: JsonObject | undefined;
  const jsonSchema = () => {
    // "output" closes the object; "input" would leave additionalProperties open.
    json ??= withoutStringPropertyNames(
      z.toJSONSchema(schema, { target: "draft-7", io: "output" }),
    ) as JsonObject;
    return json;
  };
  return {
    "~standard": {
      ...schema["~standard"],
      jsonSchema: { input: jsonSchema, output: jsonSchema },
    },
  };
}
