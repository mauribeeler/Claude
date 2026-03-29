#!/usr/bin/env python3
"""
NotebookLM Research Pipeline — Bohemia Canvas / Mauricio Beeler
Wraps notebooklm-py to create notebooks, add sources, and generate deliverables.
"""

import asyncio
import argparse
import os
import sys
import json
from pathlib import Path

OUTPUT_DIR = Path(__file__).parent / "notebooklm_output"
OUTPUT_DIR.mkdir(exist_ok=True)


async def run_pipeline(
    topic: str,
    sources: list[str] | None = None,
    deliverables: list[str] | None = None,
    infographic_style: str | None = None,
    audio_language: str = "en",
):
    from notebooklm import NotebookLMClient

    if deliverables is None:
        deliverables = ["infographic", "audio"]

    print(f"[1/5] Connecting to NotebookLM...")
    async with await NotebookLMClient.from_storage() as client:

        # --- Create notebook ---
        notebook_name = f"Research: {topic}"
        print(f"[2/5] Creating notebook: {notebook_name}")
        nb = await client.notebooks.create(notebook_name)
        print(f"       Notebook ID: {nb.id}")

        # --- Add sources ---
        if sources:
            print(f"[3/5] Adding {len(sources)} source(s)...")
            for src in sources:
                src = src.strip()
                if not src:
                    continue
                if src.startswith("http://") or src.startswith("https://"):
                    print(f"       + URL: {src}")
                    await client.sources.add_url(nb.id, src, wait=True)
                elif os.path.isfile(src):
                    print(f"       + File: {src}")
                    await client.sources.add_file(nb.id, src, wait=True)
                else:
                    print(f"       ! Skipped (not a URL or existing file): {src}")
        else:
            print(f"[3/5] No explicit sources — using web research for topic...")
            try:
                await client.sources.add_research(nb.id, topic, wait=True)
                print(f"       + Web research added for: {topic}")
            except Exception as e:
                print(f"       ! Web research failed ({e}), continuing without sources.")

        # --- Generate deliverables ---
        print(f"[4/5] Generating deliverables: {', '.join(deliverables)}")

        for deliverable in deliverables:
            deliverable = deliverable.strip().lower()

            if deliverable == "infographic":
                print("       Generating infographic...")
                instructions = infographic_style or "handwritten / chalkboard style"
                try:
                    status = await client.artifacts.generate_infographic(
                        nb.id, instructions=instructions
                    )
                    await client.artifacts.wait_for_completion(nb.id, status.task_id)
                    out_path = str(OUTPUT_DIR / f"{_safe_name(topic)}_infographic.png")
                    await client.artifacts.download_infographic(nb.id, out_path)
                    print(f"       -> Saved: {out_path}")
                except Exception as e:
                    print(f"       ! Infographic error: {e}")

            elif deliverable == "audio":
                print("       Generating audio overview...")
                try:
                    instructions = f"Language: {audio_language}. Make it clear, engaging and informative."
                    status = await client.artifacts.generate_audio(
                        nb.id, instructions=instructions
                    )
                    await client.artifacts.wait_for_completion(nb.id, status.task_id)
                    out_path = str(OUTPUT_DIR / f"{_safe_name(topic)}_audio.mp3")
                    await client.artifacts.download_audio(nb.id, out_path)
                    print(f"       -> Saved: {out_path}")
                except Exception as e:
                    print(f"       ! Audio error: {e}")

            elif deliverable == "slides":
                print("       Generating slide deck...")
                try:
                    status = await client.artifacts.generate_slide_deck(nb.id)
                    await client.artifacts.wait_for_completion(nb.id, status.task_id)
                    out_path = str(OUTPUT_DIR / f"{_safe_name(topic)}_slides.pdf")
                    await client.artifacts.download_slide_deck(nb.id, out_path)
                    print(f"       -> Saved: {out_path}")
                except Exception as e:
                    print(f"       ! Slides error: {e}")

            elif deliverable == "flashcards":
                print("       Generating flashcards...")
                try:
                    status = await client.artifacts.generate_flashcards(nb.id)
                    await client.artifacts.wait_for_completion(nb.id, status.task_id)
                    out_path = str(OUTPUT_DIR / f"{_safe_name(topic)}_flashcards.json")
                    await client.artifacts.download_flashcards(
                        nb.id, out_path, output_format="json"
                    )
                    print(f"       -> Saved: {out_path}")
                except Exception as e:
                    print(f"       ! Flashcards error: {e}")

            elif deliverable == "quiz":
                print("       Generating quiz...")
                try:
                    status = await client.artifacts.generate_quiz(nb.id)
                    await client.artifacts.wait_for_completion(nb.id, status.task_id)
                    out_path = str(OUTPUT_DIR / f"{_safe_name(topic)}_quiz.json")
                    await client.artifacts.download_quiz(
                        nb.id, out_path, output_format="json"
                    )
                    print(f"       -> Saved: {out_path}")
                except Exception as e:
                    print(f"       ! Quiz error: {e}")

            elif deliverable == "mindmap":
                print("       Generating mind map...")
                try:
                    status = await client.artifacts.generate_mind_map(nb.id)
                    await client.artifacts.wait_for_completion(nb.id, status.task_id)
                    out_path = str(OUTPUT_DIR / f"{_safe_name(topic)}_mindmap.json")
                    await client.artifacts.download_mind_map(nb.id, out_path)
                    print(f"       -> Saved: {out_path}")
                except Exception as e:
                    print(f"       ! Mind map error: {e}")

            elif deliverable == "video":
                print("       Generating video...")
                try:
                    status = await client.artifacts.generate_video(nb.id)
                    await client.artifacts.wait_for_completion(nb.id, status.task_id)
                    out_path = str(OUTPUT_DIR / f"{_safe_name(topic)}_video.mp4")
                    await client.artifacts.download_video(nb.id, out_path)
                    print(f"       -> Saved: {out_path}")
                except Exception as e:
                    print(f"       ! Video error: {e}")

            else:
                print(f"       ! Unknown deliverable: {deliverable}")

        print(f"[5/5] Done. All outputs saved to: {OUTPUT_DIR}")
        print(f"       Notebook: {notebook_name} (ID: {nb.id})")
        return nb.id


def _safe_name(topic: str) -> str:
    return "".join(c if c.isalnum() or c in (" ", "-", "_") else "" for c in topic).strip().replace(" ", "_")[:60]


def main():
    parser = argparse.ArgumentParser(description="NotebookLM Research Pipeline")
    parser.add_argument("topic", help="Research topic")
    parser.add_argument("--sources", nargs="*", help="URLs or file paths to add as sources")
    parser.add_argument(
        "--deliverables",
        nargs="*",
        default=["infographic", "audio"],
        help="Deliverables to generate: infographic, audio, slides, flashcards, quiz, mindmap, video",
    )
    parser.add_argument("--infographic-style", default="handwritten / chalkboard style", help="Infographic style instructions")
    parser.add_argument("--audio-language", default="en", help="Audio language (default: en)")
    args = parser.parse_args()

    asyncio.run(
        run_pipeline(
            topic=args.topic,
            sources=args.sources,
            deliverables=args.deliverables,
            infographic_style=args.infographic_style,
            audio_language=args.audio_language,
        )
    )


if __name__ == "__main__":
    main()
