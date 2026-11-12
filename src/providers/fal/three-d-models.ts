/** Verified fal.ai 3D presets. */
interface Fal3dPreset {
  id: string;
  mode: "text" | "image" | "multi-image";
  field: "prompt" | "image_url" | "image_urls" | "input_image_url";
  maxImages: number;
}
export const FAL_3D_PRESETS: readonly Fal3dPreset[] = [
  { id: "tripo3d/h3.1/image-to-3d", mode: "image", field: "image_url", maxImages: 1 },
  { id: "tripo3d/h3.1/multiview-to-3d", mode: "multi-image", field: "image_urls", maxImages: 4 },
  { id: "tripo3d/h3.1/text-to-3d", mode: "text", field: "prompt", maxImages: 0 },
  { id: "hitem3d/hi3d/v3.0/image-to-3d", mode: "image", field: "image_url", maxImages: 1 },
  { id: "hitem3d/hi3d/image-to-3d", mode: "image", field: "image_url", maxImages: 1 },
  {
    id: "fal-ai/hunyuan-3d/v3.1/rapid/image-to-3d",
    mode: "image",
    field: "input_image_url",
    maxImages: 1,
  },
  { id: "fal-ai/hunyuan-3d/v3.1/rapid/text-to-3d", mode: "text", field: "prompt", maxImages: 0 },
  {
    id: "fal-ai/hunyuan-3d/v3.1/pro/image-to-3d",
    mode: "image",
    field: "input_image_url",
    maxImages: 1,
  },
  { id: "fal-ai/hunyuan-3d/v3.1/pro/text-to-3d", mode: "text", field: "prompt", maxImages: 0 },
  ...(["v7", "v7.1"] as const).flatMap((version) => [
    {
      id: `meshy/${version}/image-to-3d`,
      mode: "image" as const,
      field: "image_url" as const,
      maxImages: 1,
    },
    {
      id: `meshy/${version}/multi-image-to-3d`,
      mode: "multi-image" as const,
      field: "image_urls" as const,
      maxImages: 4,
    },
    {
      id: `meshy/${version}/text-to-3d`,
      mode: "text" as const,
      field: "prompt" as const,
      maxImages: 0,
    },
  ]),
];
