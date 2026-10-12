# Vanilla subset

This directory contains the Vanilla design tokens, font assets, and the palette/glass components used by Encoder. They are included here so cloning and building Encoder does not require a separate Vanilla checkout.

The original package license metadata (`UNLICENSED`) is preserved. The fonts retain their SIL Open Font License notices in `tokens/fonts/OFL.txt` and `tokens/fonts/NotoEmoji-OFL.txt`.

Only the palette and glass source is included from Petals; unrelated editors and their dependencies are omitted. React and React DOM are peer dependencies resolved from Encoder, with Vite deduplication retained for production builds.
