---
name: fal-ai-studio
description: Multi-modal generative media pipeline using Fal.ai SDK covering image generation, image editing, video synthesis (Kling/Minimax), 3D mesh reconstruction, audio lip-sync, and model training.
---

# Fal AI Studio

Unified generative media interface for Fal.ai serverless AI pipelines across image, video, 3D, and audio modalities.

## Supported Modalities & Routing

### 1. Image Generation & Editing (`image`)
- **Text-to-Image**: FLUX.1 [dev], FLUX.1 [schnell], SDXL.
- **Image-to-Image & Inpainting**: Mask-based editing, style transfer, and background replacement.
- **Upscaling & Restoration**: Real-ESRGAN, Clarity Upscaler, face restoration (GFPGAN).
- **Virtual Try-On**: CatVTON human garment transfer.

### 2. Video Generation & Video Editing (`video`)
- **Video Synthesis**: Kling v1.5 / v2.0, Minimax Video-01, Luma Dream Machine, Runway Gen-3.
- **Video Editing**: Inpainting, motion transfer, background removal, and video upscaling.

### 3. 3D Mesh Generation (`3d`)
- Single-image to 3D mesh (GLTF/GLB/OBJ) with texture maps (TripoSR, CRM, InstantMesh).

### 4. Audio & Lip Sync (`audio`)
- High-fidelity lip-synchronization for talking avatars (SadTalker, Wav2Lip, MuseTalk).

### 5. Realtime & Training (`realtime` / `train`)
- Realtime sub-100ms image generation with LCM / SDXL-Lightning via WebSockets.
- LoRA fine-tuning for custom subjects, characters, and styles.

## Usage Pattern

```typescript
import { fal } from "@fal-ai/serverless-client";

fal.config({ credentials: process.env.FAL_KEY });

// Image Generation
const imageResult = await fal.subscribe("fal-ai/flux/dev", {
  input: {
    prompt: "A cinematic portrait of a cybernetic penguin in neon mist",
    image_size: "landscape_16_9",
    num_inference_steps: 28,
  },
});

// Video Synthesis
const videoResult = await fal.subscribe("fal-ai/kling-video/v1/standard/text-to-video", {
  input: {
    prompt: "An orbital camera pan around a futuristic space station",
    duration: "5",
  },
});
```
