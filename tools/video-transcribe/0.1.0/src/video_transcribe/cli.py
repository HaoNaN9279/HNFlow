"""Command-line interface for video-transcribe."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from video_transcribe import (
    builder,
    capture,
    cleaner,
    downloader,
    model_manager,
    probe,
    scenes,
)
from video_transcribe.asr import DEFAULT_DEVICE, Transcriber
from video_transcribe.errors import VideoTranscribeError
from video_transcribe.ffmpeg import extract_audio
from video_transcribe.model_manager import DEFAULT_PROXY, ensure_models, status
from video_transcribe.paths import Job

_ENV_MODELS_DIR = "VIDEO_TRANSCRIBE_MODELS"


def default_models_dir() -> Path:
    """Return the default models directory.

    Prefers ``VIDEO_TRANSCRIBE_MODELS``; otherwise ``<tool_root>/models`` where
    ``<tool_root>`` is derived from the package location (valid for the
    editable installs used by ``uv run --project``).
    """
    override = os.environ.get(_ENV_MODELS_DIR)
    if override:
        return Path(override)
    tool_root = Path(__file__).resolve().parents[2]
    return tool_root / "models"


def resolve_proxy(explicit: str | None) -> str:
    """Resolve the proxy URL: explicit flag → ``HTTPS_PROXY`` → default."""
    return explicit or os.environ.get("HTTPS_PROXY") or DEFAULT_PROXY


def build_parser() -> argparse.ArgumentParser:
    """Construct the argument parser."""
    parser = argparse.ArgumentParser(
        prog="video-transcribe",
        description="下载视频、提取音频、Qwen3-ASR 转写、截取关键画面并生成内嵌图片的 Markdown。",
    )
    parser.add_argument(
        "--model-dir",
        type=Path,
        default=default_models_dir(),
        help="模型存放目录（默认 <tool>/models，可用 VIDEO_TRANSCRIBE_MODELS 覆盖）",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_fetch = sub.add_parser("fetch", help="下载视频（或导入本地视频文件）并创建 job 目录")
    p_fetch.add_argument("source", help="视频页面 URL，或本地视频文件路径")
    p_fetch.add_argument("--out", type=Path, required=True, help="输出根目录")
    p_fetch.add_argument("--proxy", default=None, help="代理 URL")

    p_tr = sub.add_parser("transcribe", help="提取音频并转写为带时间戳的文本")
    p_tr.add_argument("job", type=Path, help="job 目录")
    p_tr.add_argument("--device", default=DEFAULT_DEVICE, help="torch 设备（默认 cuda）")
    p_tr.add_argument("--language", default=None, help="强制语言，如 Chinese；默认自动检测")
    p_tr.add_argument("--context", default=None, help="领域术语提示，保留专业词汇")
    p_tr.add_argument("--source", choices=["hf", "modelscope"], default="hf")
    p_tr.add_argument("--proxy", default=None, help="代理 URL")

    p_probe = sub.add_parser("probe", help="按固定间隔抽缩略图，生成带时间戳的 contact sheet")
    p_probe.add_argument("job", type=Path, help="job 目录")
    p_probe.add_argument("--interval", type=float, default=probe.DEFAULT_INTERVAL, help="每帧间隔秒数（默认 3）")
    p_probe.add_argument("--cols", type=int, default=probe.DEFAULT_COLS, help="contact sheet 列数")
    p_probe.add_argument("--rows", type=int, default=probe.DEFAULT_ROWS, help="contact sheet 行数")
    p_probe.add_argument("--thumb-width", type=int, default=probe.DEFAULT_THUMB_WIDTH, help="缩略图宽度")
    p_probe.add_argument("--max-samples", type=int, default=probe.DEFAULT_MAX_SAMPLES, help="缩略图数量上限")

    p_scenes = sub.add_parser("scenes", help="场景检测，输出镜头切换时间列表")
    p_scenes.add_argument("job", type=Path, help="job 目录")
    p_scenes.add_argument("--threshold", type=float, default=scenes.DEFAULT_THRESHOLD, help="场景分数阈值（默认 0.3）")

    p_cap = sub.add_parser("capture", help="按 marks.json 时间窗口截取关键画面")
    p_cap.add_argument("job", type=Path, help="job 目录")
    p_cap.add_argument("--cols", type=int, default=capture.DEFAULT_MANIFEST_COLS, help="回看 contact sheet 列数")
    p_cap.add_argument("--rows", type=int, default=capture.DEFAULT_MANIFEST_ROWS, help="回看 contact sheet 行数")
    p_cap.add_argument("--no-sheet", action="store_true", help="不生成回看 contact sheet")

    p_build = sub.add_parser("build", help="生成内嵌图片的 Markdown")
    p_build.add_argument("job", type=Path, help="job 目录")

    p_clean = sub.add_parser("clean", help="清理中间产物，仅保留 md 与 frames 截图")
    p_clean.add_argument("job", type=Path, help="job 目录")

    p_model = sub.add_parser("model", help="模型管理")
    model_sub = p_model.add_subparsers(dest="model_command", required=True)
    model_sub.add_parser("status", help="检测模型是否存在")
    p_me = model_sub.add_parser("ensure", help="下载缺失的模型")
    p_me.add_argument("--source", choices=["hf", "modelscope"], default="hf")
    p_me.add_argument("--proxy", default=None, help="代理 URL")

    return parser


def _cmd_fetch(args: argparse.Namespace) -> int:
    candidate = Path(args.source)
    if candidate.is_file():
        job = downloader.import_video(candidate, args.out)
        print(f"已导入本地视频: {job.video_path}")
    else:
        job = downloader.download(args.source, args.out, proxy=resolve_proxy(args.proxy))
        print(f"已下载: {job.video_path}")
    print(f"job 目录: {job.root}")
    return 0


def _cmd_transcribe(args: argparse.Namespace) -> int:
    job = Job.load(args.job)
    proxy = resolve_proxy(args.proxy)

    print(f"[1/3] 提取音频 -> {job.audio_path}")
    extract_audio(job.video_path, job.audio_path)

    print(f"[2/3] 检查模型 (source={args.source}) ...")
    asr_dir, aligner_dir = ensure_models(args.model_dir, source=args.source, proxy=proxy)

    print(f"[3/3] 转写 (device={args.device}) ...")
    transcriber = Transcriber(asr_dir, aligner_dir, device=args.device)
    transcript = transcriber.transcribe(
        job.audio_path, language=args.language, context=args.context
    )
    transcript.save(job.transcript_path)
    job.transcript_text_path.write_text(transcript.text, encoding="utf-8")
    print(f"完成: {job.transcript_path} ({len(transcript.segments)} 段)")
    return 0


def _cmd_probe(args: argparse.Namespace) -> int:
    job = Job.load(args.job)
    index = probe.generate(
        job,
        interval=args.interval,
        cols=args.cols,
        rows=args.rows,
        thumb_width=args.thumb_width,
        max_samples=args.max_samples,
    )
    total = sum(len(sheet.cells) for sheet in index.sheets)
    print(f"已生成 {len(index.sheets)} 张 contact sheet（共 {total} 帧，间隔 {index.interval}s）")
    print(f"索引: {job.probe_index_path}")
    return 0


def _cmd_scenes(args: argparse.Namespace) -> int:
    job = Job.load(args.job)
    result = scenes.detect(job, threshold=args.threshold)
    print(f"检测到 {len(result.scenes)} 个镜头边界（阈值 {args.threshold}）")
    print(f"结果: {job.scenes_path}")
    return 0


def _cmd_capture(args: argparse.Namespace) -> int:
    job = Job.load(args.job)
    manifest = capture.capture_frames(
        job,
        cols=args.cols,
        rows=args.rows,
        with_sheet=not args.no_sheet,
    )
    print(f"已捕获 {len(manifest.frames)} 帧 -> {job.frames_dir}")
    if not args.no_sheet and manifest.frames:
        print(f"回看 contact sheet -> {job.frames_dir / 'contact_sheet_0001.png'}")
    return 0


def _cmd_build(args: argparse.Namespace) -> int:
    job = Job.load(args.job)
    path = builder.build(job)
    print(f"已生成 Markdown: {path}")
    return 0


def _cmd_clean(args: argparse.Namespace) -> int:
    job = Job.load(args.job)
    removed = cleaner.clean_job(job)
    print(f"已清理 {len(removed)} 项中间产物，保留: {job.markdown_path.name} 与 frames/frame_*.png")
    return 0


def _cmd_model(args: argparse.Namespace) -> int:
    if args.model_command == "status":
        result = status(args.model_dir)
        print(f"模型目录: {args.model_dir}")
        print(f"ASR     ({model_manager.ASR_DIRNAME}): {'已存在' if result.asr_present else '缺失'}")
        print(
            f"Aligner ({model_manager.ALIGNER_DIRNAME}): "
            f"{'已存在' if result.aligner_present else '缺失'}"
        )
        return 0

    asr_dir, aligner_dir = ensure_models(
        args.model_dir, source=args.source, proxy=resolve_proxy(args.proxy)
    )
    print(f"ASR: {asr_dir}")
    print(f"Aligner: {aligner_dir}")
    return 0


def main(argv: list[str] | None = None) -> int:
    """Entry point for the ``video-transcribe`` command."""
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        if args.command == "fetch":
            return _cmd_fetch(args)
        if args.command == "transcribe":
            return _cmd_transcribe(args)
        if args.command == "probe":
            return _cmd_probe(args)
        if args.command == "scenes":
            return _cmd_scenes(args)
        if args.command == "capture":
            return _cmd_capture(args)
        if args.command == "build":
            return _cmd_build(args)
        if args.command == "clean":
            return _cmd_clean(args)
        if args.command == "model":
            return _cmd_model(args)
    except VideoTranscribeError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1

    parser.error(f"未知命令: {args.command}")
    return 2
