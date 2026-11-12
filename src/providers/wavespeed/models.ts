/** WaveSpeedAI 3D endpoints verified against each provider's model API page. */
export const WAVESPEED_ROUTING = {
  name: "WAVESPEED_BASE_URL",
  defaultUrl: "https://api.wavespeed.ai/api/v3",
  keyEnvs: ["WAVESPEED_API_KEY"],
} as const;

export interface Wave3DModel {
  id: string;
  mode: "image" | "multi-image" | "text";
  field: "image" | "images" | "prompt";
  maxImages: number;
  source: string;
}

export const WAVESPEED_3D_MODELS: readonly Wave3DModel[] = [
  {
    id: "bytedance/seed3d-2.0/image-to-3d",
    mode: "image",
    field: "image",
    maxImages: 1,
    source: "https://wavespeed.ai/models/bytedance/seed3d-2.0/image-to-3d",
  },
  {
    id: "tripo3d/h3.1/image-to-3d",
    mode: "image",
    field: "image",
    maxImages: 1,
    source: "https://wavespeed.ai/models/tripo3d/h3.1/image-to-3d",
  },
  {
    id: "tripo3d/h3.1/text-to-3d",
    mode: "text",
    field: "prompt",
    maxImages: 0,
    source: "https://wavespeed.ai/models/tripo3d/h3.1/text-to-3d",
  },
  {
    id: "tripo3d/h3.1/multiview-to-3d",
    mode: "multi-image",
    field: "images",
    maxImages: 4,
    source: "https://wavespeed.ai/tripo-3d-studio",
  },
  {
    id: "wavespeed-ai/hunyuan-3d-v3.1/image-to-3d-rapid",
    mode: "image",
    field: "image",
    maxImages: 1,
    source: "https://wavespeed.ai/models/wavespeed-ai/hunyuan-3d-v3.1/image-to-3d-rapid",
  },
  {
    id: "wavespeed-ai/hunyuan-3d-v3.1/text-to-3d-rapid",
    mode: "text",
    field: "prompt",
    maxImages: 0,
    source: "https://wavespeed.ai/models/wavespeed-ai/hunyuan-3d-v3.1/text-to-3d-rapid",
  },
  ...(["v7", "v7.1"] as const).flatMap((version) => [
    {
      id: `meshy/${version}/image-to-3d`,
      mode: "image" as const,
      field: "image" as const,
      maxImages: 1,
      source: `https://wavespeed.ai/models/meshy/${version}/image-to-3d`,
    },
    {
      id: `meshy/${version}/multi-image-to-3d`,
      mode: "multi-image" as const,
      field: "images" as const,
      maxImages: 4,
      source: `https://wavespeed.ai/models/meshy/${version}/multi-image-to-3d`,
    },
    {
      id: `meshy/${version}/text-to-3d`,
      mode: "text" as const,
      field: "prompt" as const,
      maxImages: 0,
      source: `https://wavespeed.ai/models/meshy/${version}/text-to-3d`,
    },
  ]),
];

export const WAVESPEED_DEFAULT_3D_MODEL = "bytedance/seed3d-2.0/image-to-3d";

export function wave3dModel(id: string): Wave3DModel | undefined {
  return WAVESPEED_3D_MODELS.find((m) => m.id === id);
}

/** Never accept model IDs that could escape the API base path. */
export function validateWaveModelId(id: string): string {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*(\/[a-zA-Z0-9][a-zA-Z0-9_.-]*){1,5}$/.test(id) ||
    id.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("Invalid WaveSpeedAI model ID");
  }
  return id;
}
