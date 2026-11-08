# Cat Town motion sources

The game-specific `cat-motions.json` asset was baked from these animations downloaded through the signed-in [Adobe Mixamo](https://www.mixamo.com/) interface:

- **Unarmed Walk Forward** — Walking Forward; exported in place, without skin.
- **Talking** — General Conversation; exported without skin.
- **Typing** — Sitting At A Computer And Typing; exported without skin. Only its upper-body motion is applied while cats work at home.

`scripts/bake-mixamo.mjs` samples the source skeleton, converts hand and leg directions into bounded joint rotations, retains vertical gait motion and blends loop seams. The resulting curves drive specialist articulated meshes and the existing Mayor skeleton. Translation is handled by town lane routing. Facial blinking and mouth movement are authored locally; Mixamo does not supply these cat expressions.

Raw FBX downloads are retained locally under ignored `data/mixamo-source/` and are not served or committed. Rebuild the embedded game asset with:

```powershell
node scripts/bake-mixamo.mjs data/mixamo-source/walk.fbx data/mixamo-source/talk.fbx data/mixamo-source/work.fbx
```

The asset is incorporated into this game, not offered as a standalone animation library. Consult [Adobe’s Mixamo FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html) and [Adobe’s licensing clarification](https://community.adobe.com/questions-696/mixamo-faq-licensing-royalties-ownership-eula-and-tos-589400) before redistributing source assets.
