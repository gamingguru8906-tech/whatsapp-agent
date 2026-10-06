# Vendored copy of onetake

- Upstream: https://github.com/feitangyuan/onetake
- Commit: `cf09bde3e392c9aa32c4157f80cdbe1fa556685e`
- License: PolyForm Noncommercial 1.0.0 (see `LICENSE`)

Left out to keep the repo small (~4 MB instead of ~140 MB): the finished case films
(`cases/*/*.mp4`) and the README GIFs (`assets/hero.gif`, `assets/cases/*.gif`). The case
READMEs, gallery sheets, fonts, library and scripts are all here, so the skill works as is.

To update, re-clone upstream and copy it over this folder, again skipping `*.mp4` and `*.gif`.

Dependencies (not installed by the repo; run once per fresh environment):

```bash
pip install playwright numpy scipy Pillow matplotlib opencv-python-headless fonttools brotli
```

Also needs `ffmpeg` / `ffprobe` and `node`.
