"""Makes the Arabic voice-over for the Dosly video with edge-tts (Microsoft neural voices, Egyptian).
Run: pip install edge-tts && python make.py   -> writes salma/<id>.mp3 and shakir/<id>.mp3 next to this file."""
import asyncio, pathlib, edge_tts

HERE = pathlib.Path(__file__).parent
VOICES = {'salma': 'ar-EG-SalmaNeural', 'shakir': 'ar-EG-ShakirNeural'}

async def main():
    lines = [l.split('|', 1) for l in (HERE / 'lines.txt').read_text(encoding='utf-8').splitlines() if '|' in l]
    for folder, voice in VOICES.items():
        out = HERE / folder; out.mkdir(exist_ok=True)
        for sid, text in lines:
            await edge_tts.Communicate(text, voice, rate='-4%').save(str(out / f'{sid}.mp3'))
            print(folder, sid)

asyncio.run(main())
