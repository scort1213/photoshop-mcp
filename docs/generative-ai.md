# Cloud operations disabled

The local-only build does not advertise Firefly generation, generative fill/remove/expand/upscale, Neural Filters or the native-sky tool. Direct requests fail with `cloud_disabled` before the operation is sent to Photoshop. Do not request login, credits or a cloud service to recover.

Use these local alternatives:

- Distraction removal: `photoshop_recipe_remove_distraction` or `photoshop_content_aware_fill` after selecting the region.
- Skin retouch: `photoshop_recipe_enhance_portrait` or frequency separation.
- Sky composition: `photoshop_recipe_sky_blend` with a local image.
- Image size/canvas size: ordinary resize/canvas tools. These do not generate new image content and are not equivalent to generative results.

Select Subject/background removal remain available with Photoshop Image Processing set to Device. Custom scripts/actions are retained with guidance, not a technical sandbox. See [LOCAL_ONLY.md](../LOCAL_ONLY.md).
