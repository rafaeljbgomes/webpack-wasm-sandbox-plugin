#!/usr/bin/env python3
import argparse
import math
from pathlib import Path

import pandas as pd


GROUP_COLUMNS = ["environment", "library", "workload_id", "repetitions"]

NUMERIC_FIELDS = {
    "iteration",
    "wall_ms",
    "cpu_user_ms",
    "cpu_system_ms",
    "peak_rss_mb",
    "peak_heap_used_mb",
    "peak_external_mb",
    "final_rss_mb",
    "final_heap_used_mb",
    "final_external_mb",
    "browser_elapsed_ms",
    "browser_task_ms",
    "browser_script_ms",
    "repetitions",
    "exit_code",
    "sandbox_create_ms",
    "bundle_eval_ms",
    "webapi_expose_ms",
    "webapi_exposed_count",
    "membrane_call_count",
    "membrane_call_ms",
    "marshal_count",
    "marshal_ms",
    "unmarshal_count",
    "unmarshal_ms",
    "wrap_returned_count",
    "create_instance_count",
    "temp_object_peak_count",
    "host_to_vm_count",
    "vm_to_host_count",
    "host_to_vm_total_bytes",
    "vm_to_host_total_bytes",
    "crossing_size_median_bytes",
    "crossing_size_p95_bytes",
    "crossing_size_max_bytes",
}

RUN_METRICS = [
    "wall_ms",
    "cpu_user_ms",
    "cpu_system_ms",
    "peak_rss_mb",
    "peak_heap_used_mb",
    "peak_external_mb",
    "final_rss_mb",
    "final_heap_used_mb",
    "final_external_mb",
    "browser_elapsed_ms",
    "browser_task_ms",
    "browser_script_ms",
]

SANDBOX_DETAIL_METRICS = [
    "webapi_expose_ms",
    "webapi_exposed_count",
    "membrane_call_count",
    "membrane_call_ms",
    "host_to_vm_count",
    "vm_to_host_count",
    "host_to_vm_total_bytes",
    "vm_to_host_total_bytes",
    "crossing_count",
    "crossing_size_median_bytes",
    "crossing_size_p95_bytes",
    "crossing_total_bytes",
]

OVERHEAD_METRICS = [
    "wall_ratio",
    "wall_delta_ms",
    "browser_elapsed_ratio",
    "browser_task_ratio",
    "cpu_delta_ms",
    "rss_delta_mb",
    "peak_heap_sandbox_mb",
    "peak_heap_native_mb",
    "peak_heap_delta_mb",
    "peak_heap_ratio",
]

CORRELATION_INPUTS = [
    ("crossing count", "crossing_count"),
    ("median crossing size", "crossing_size_median_bytes"),
    ("p95 crossing size", "crossing_size_p95_bytes"),
    ("total crossing bytes", "crossing_total_bytes"),
]

DIRECTIONAL_CORRELATION_INPUTS = [
    ("host->VM crossings", "host_to_vm_count"),
    ("VM->host crossings", "vm_to_host_count"),
    ("host->VM bytes", "host_to_vm_total_bytes"),
    ("VM->host bytes", "vm_to_host_total_bytes"),
]

RUNTIME_CORRELATION_TARGETS = [
    ("overhead", "wall_ratio"),
]

MEMORY_CORRELATION_TARGETS = [
    ("peak heap ratio", "peak_heap_ratio"),
]


def load_csv(path):
    if not path.exists():
        return pd.DataFrame()

    frame = pd.read_csv(path)
    for column in NUMERIC_FIELDS.intersection(frame.columns):
        frame[column] = pd.to_numeric(frame[column], errors="coerce").fillna(0.0)
    for column in ["warmup", "completed"]:
        if column in frame.columns:
            frame[column] = frame[column].astype(str).str.lower().eq("true")
    return frame


def prepare_runs(runs):
    runs = runs.copy()
    defaults = {
        "run_id": "",
        "environment": "node",
        "library": "",
        "workload_id": "",
        "repetitions": 1.0,
        "mode": "",
        "iteration": 0.0,
        "warmup": False,
        "completed": True,
        "exit_code": 0.0,
    }
    for column, default in defaults.items():
        if column not in runs.columns:
            runs[column] = default
        else:
            runs[column] = runs[column].fillna(default)

    for metric in RUN_METRICS:
        if metric not in runs.columns:
            runs[metric] = 0.0

    return runs


def prepare_metrics(frame, metrics):
    frame = frame.copy()
    for metric in metrics:
        if metric not in frame.columns:
            frame[metric] = 0.0
        else:
            frame[metric] = pd.to_numeric(frame[metric], errors="coerce").fillna(0.0)
    return frame


def summarize_runs(runs):
    if runs.empty:
        return pd.DataFrame(columns=[*GROUP_COLUMNS, "mode", "runs", *RUN_METRICS])

    grouped = runs.groupby([*GROUP_COLUMNS, "mode"], sort=False, dropna=False)
    medians = grouped[RUN_METRICS].median().reset_index()
    medians["runs"] = grouped.size().to_numpy()
    return medians[[*GROUP_COLUMNS, "mode", "runs", *RUN_METRICS]]


def summarize_sandbox_details(runs, events, crossings):
    sandbox_runs = runs[runs["mode"] == "sandbox"]
    if sandbox_runs.empty:
        return pd.DataFrame(columns=[*GROUP_COLUMNS, *SANDBOX_DETAIL_METRICS])

    details = sandbox_runs[["run_id", *GROUP_COLUMNS]].copy()
    if not events.empty:
        details = details.merge(events, on="run_id", how="left")
    if not crossings.empty:
        details = details.merge(crossings, on="run_id", how="left")

    source_metrics = [
        "webapi_expose_ms",
        "webapi_exposed_count",
        "membrane_call_count",
        "membrane_call_ms",
        "host_to_vm_count",
        "vm_to_host_count",
        "host_to_vm_total_bytes",
        "vm_to_host_total_bytes",
        "crossing_size_median_bytes",
        "crossing_size_p95_bytes",
    ]
    details = prepare_metrics(details, source_metrics)
    details["crossing_count"] = details["host_to_vm_count"] + details["vm_to_host_count"]
    details["crossing_total_bytes"] = (
        details["host_to_vm_total_bytes"] + details["vm_to_host_total_bytes"]
    )

    return (
        details.groupby(GROUP_COLUMNS, sort=False, dropna=False)[SANDBOX_DETAIL_METRICS]
        .median()
        .reset_index()
    )


def build_overhead_rows(summaries, sandbox_details):
    native = summaries[summaries["mode"] == "native"]
    sandbox = summaries[summaries["mode"] == "sandbox"]
    if native.empty or sandbox.empty:
        return pd.DataFrame(columns=[*GROUP_COLUMNS, *OVERHEAD_METRICS, *SANDBOX_DETAIL_METRICS])

    overhead = sandbox.merge(
        native,
        on=GROUP_COLUMNS,
        how="inner",
        suffixes=("_sandbox", "_native"),
    )
    overhead["wall_ratio"] = overhead["wall_ms_sandbox"] / overhead[
        "wall_ms_native"
    ].replace(0, math.nan)
    overhead["browser_elapsed_ratio"] = overhead[
        "browser_elapsed_ms_sandbox"
    ] / overhead["browser_elapsed_ms_native"].replace(0, math.nan)
    overhead["browser_task_ratio"] = overhead["browser_task_ms_sandbox"] / overhead[
        "browser_task_ms_native"
    ].replace(0, math.nan)
    overhead["wall_delta_ms"] = overhead["wall_ms_sandbox"] - overhead["wall_ms_native"]
    overhead["cpu_delta_ms"] = (
        overhead["cpu_user_ms_sandbox"]
        + overhead["cpu_system_ms_sandbox"]
        - overhead["cpu_user_ms_native"]
        - overhead["cpu_system_ms_native"]
    )
    overhead["rss_delta_mb"] = (
        overhead["peak_rss_mb_sandbox"] - overhead["peak_rss_mb_native"]
    )
    overhead["peak_heap_sandbox_mb"] = overhead["peak_heap_used_mb_sandbox"]
    overhead["peak_heap_native_mb"] = overhead["peak_heap_used_mb_native"]
    overhead["peak_heap_delta_mb"] = (
        overhead["peak_heap_sandbox_mb"] - overhead["peak_heap_native_mb"]
    )
    overhead["peak_heap_ratio"] = overhead["peak_heap_sandbox_mb"] / overhead[
        "peak_heap_native_mb"
    ].replace(0, math.nan)

    if not sandbox_details.empty:
        overhead = overhead.merge(sandbox_details, on=GROUP_COLUMNS, how="left")

    overhead = prepare_metrics(overhead, SANDBOX_DETAIL_METRICS)
    return overhead[
        [
            *GROUP_COLUMNS,
            *OVERHEAD_METRICS,
            *SANDBOX_DETAIL_METRICS,
        ]
    ]


def workload_label(row):
    return f'{row.library}:{row.workload_id}:reps={row.repetitions:.0f}'


def build_runtime_ratio_samples(runs):
    if runs.empty:
        return pd.DataFrame(columns=[*GROUP_COLUMNS, "sample_index", "wall_ratio"])

    pairs = runs[[*GROUP_COLUMNS, "mode", "iteration", "wall_ms"]].copy()
    pairs = pairs[pairs["mode"].isin(["native", "sandbox"])]
    if pairs.empty:
        return pd.DataFrame(columns=[*GROUP_COLUMNS, "sample_index", "wall_ratio"])

    pairs["source_index"] = range(len(pairs))
    pairs = pairs.sort_values([*GROUP_COLUMNS, "mode", "iteration", "source_index"])
    pairs["sample_index"] = pairs.groupby(
        [*GROUP_COLUMNS, "mode"], sort=False, dropna=False
    ).cumcount()

    native = pairs[pairs["mode"] == "native"]
    sandbox = pairs[pairs["mode"] == "sandbox"]
    if native.empty or sandbox.empty:
        return pd.DataFrame(columns=[*GROUP_COLUMNS, "sample_index", "wall_ratio"])

    ratios = sandbox.merge(
        native,
        on=[*GROUP_COLUMNS, "sample_index"],
        how="inner",
        suffixes=("_sandbox", "_native"),
    )
    ratios["wall_ratio"] = ratios["wall_ms_sandbox"] / ratios[
        "wall_ms_native"
    ].replace(0, math.nan)
    ratios = ratios.replace([math.inf, -math.inf], pd.NA).dropna(
        subset=["wall_ratio"]
    )
    return ratios[[*GROUP_COLUMNS, "sample_index", "wall_ratio"]]


def spearman(xs, ys):
    values = pd.DataFrame({"x": xs, "y": ys}).replace([math.inf, -math.inf], pd.NA)
    values = values.apply(pd.to_numeric, errors="coerce").dropna()
    if len(values) < 2 or values["x"].nunique() < 2 or values["y"].nunique() < 2:
        return math.nan
    ranks = values.rank(method="average")
    return ranks["x"].corr(ranks["y"], method="pearson")


def plot_labeled_scatter(plt, xs, ys, labels, xlabel, ylabel, title, output_path):
    plt.figure(figsize=(10, 7))
    plt.scatter(xs, ys)

    for index, (x, y, label) in enumerate(zip(xs, ys, labels)):
        x_offset = 6 if index % 2 == 0 else -6
        y_offset = 6 if (index // 2) % 2 == 0 else -6
        horizontal_alignment = "left" if x_offset > 0 else "right"
        vertical_alignment = "bottom" if y_offset > 0 else "top"

        plt.annotate(
            label,
            (x, y),
            textcoords="offset points",
            xytext=(x_offset, y_offset),
            ha=horizontal_alignment,
            va=vertical_alignment,
            fontsize=8,
            bbox={"boxstyle": "round,pad=0.2", "fc": "white", "alpha": 0.7, "lw": 0},
        )

    plt.xlabel(xlabel)
    plt.ylabel(ylabel)
    plt.title(title)
    plt.tight_layout()
    plt.savefig(output_path)
    plt.close()


def print_correlations(overhead_rows):
    print("\nSpearman correlations:")
    for target_label, target_column in RUNTIME_CORRELATION_TARGETS:
        for input_label, input_column in CORRELATION_INPUTS:
            print(
                f"  {target_label} vs {input_label}:",
                f"{spearman(overhead_rows[input_column], overhead_rows[target_column]):.3f}",
            )
        for input_label, input_column in DIRECTIONAL_CORRELATION_INPUTS:
            print(
                f"  {target_label} vs {input_label}:",
                f"{spearman(overhead_rows[input_column], overhead_rows[target_column]):.3f}",
            )

    print("\nSpearman memory overhead correlations:")
    for target_label, target_column in MEMORY_CORRELATION_TARGETS:
        for input_label, input_column in CORRELATION_INPUTS:
            print(
                f"  {target_label} vs {input_label}:",
                f"{spearman(overhead_rows[input_column], overhead_rows[target_column]):.3f}",
            )
        for input_label, input_column in DIRECTIONAL_CORRELATION_INPUTS:
            print(
                f"  {target_label} vs {input_label}:",
                f"{spearman(overhead_rows[input_column], overhead_rows[target_column]):.3f}",
            )


def plot_runtime_overhead_boxplot(plt, runtime_ratio_samples, overhead_rows, output_path):
    if runtime_ratio_samples.empty:
        return

    samples = runtime_ratio_samples.copy()
    samples["label"] = [workload_label(row) for row in samples.itertuples()]

    if overhead_rows.empty:
        labels = list(dict.fromkeys(samples["label"]))
    else:
        labels = [workload_label(row) for row in overhead_rows.itertuples()]
        labels = [label for label in labels if label in set(samples["label"])]

    if not labels:
        return

    grouped = samples.groupby("label", sort=False)["wall_ratio"]
    box_values = [grouped.get_group(label).tolist() for label in labels]

    figure_width = max(14, len(labels) * 2.5)
    figure = plt.figure(figsize=(figure_width, 8), constrained_layout=True)
    grid = figure.add_gridspec(2, len(labels), height_ratios=[1, 2.2])
    overview_axis = figure.add_subplot(grid[0, :])
    detail_axes = [figure.add_subplot(grid[1, index]) for index in range(len(labels))]
    figure.suptitle("Runtime Overhead Distribution by Workload")

    box_style = {
        "patch_artist": True,
        "showfliers": False,
        "boxprops": {"facecolor": "#d9e8fb", "edgecolor": "#2f5f98"},
        "medianprops": {"color": "#111111", "linewidth": 1.6},
        "whiskerprops": {"color": "#2f5f98"},
        "capprops": {"color": "#2f5f98"},
    }

    overview_axis.boxplot(
        box_values,
        tick_labels=labels,
        **box_style,
    )

    for position, values in enumerate(box_values, start=1):
        if not values:
            continue
        if len(values) == 1:
            offsets = [0]
        else:
            step = min(0.08, 0.28 / max(len(values) - 1, 1))
            start = -step * (len(values) - 1) / 2
            offsets = [start + index * step for index in range(len(values))]
        overview_axis.scatter(
            [position + offset for offset in offsets],
            values,
            color="#1f77b4",
            alpha=0.65,
            s=20,
            zorder=3,
        )
        overview_axis.text(
            position,
            max(values),
            f"n={len(values)}",
            ha="center",
            va="bottom",
            fontsize=8,
        )

    all_values = [value for values in box_values for value in values]
    positive_values = [value for value in all_values if value > 0]
    use_log_scale = (
        len(positive_values) == len(all_values)
        and positive_values
        and max(positive_values) / min(positive_values) >= 20
    )

    overview_axis.axhline(1.0, color="#666666", linestyle="--", linewidth=1)
    if use_log_scale:
        overview_axis.set_yscale("log")
        overview_axis.set_ylabel("Absolute ratio (log scale)")
    else:
        overview_axis.set_ylabel("Absolute ratio")
    overview_axis.set_title("Shared-scale overview")
    overview_axis.margins(y=0.12)
    overview_axis.tick_params(axis="x", rotation=45, labelsize=8)
    for tick in overview_axis.get_xticklabels():
        tick.set_ha("right")

    for axis, label, values in zip(detail_axes, labels, box_values):
        axis.boxplot([values], tick_labels=[""], widths=0.45, **box_style)
        if len(values) == 1:
            offsets = [0]
        else:
            step = min(0.06, 0.22 / max(len(values) - 1, 1))
            start = -step * (len(values) - 1) / 2
            offsets = [start + index * step for index in range(len(values))]
        axis.scatter(
            [1 + offset for offset in offsets],
            values,
            color="#1f77b4",
            alpha=0.7,
            s=22,
            zorder=3,
        )

        series = pd.Series(values)
        median = series.median()
        q1 = series.quantile(0.25)
        q3 = series.quantile(0.75)
        span = max(values) - min(values)
        pad = span * 0.45 if span > 0 else max(abs(median) * 0.05, 0.05)
        axis.set_ylim(min(values) - pad, max(values) + pad)
        axis.set_title(label, fontsize=9)
        axis.text(
            0.5,
            0.98,
            f"median={median:.2f}x\nIQR={q1:.2f}-{q3:.2f}x",
            transform=axis.transAxes,
            ha="center",
            va="top",
            fontsize=8,
            bbox={"boxstyle": "round,pad=0.25", "fc": "white", "alpha": 0.85, "lw": 0},
        )
        axis.tick_params(axis="x", bottom=False)
        axis.grid(axis="y", alpha=0.25)

    detail_axes[0].set_ylabel("Local ratio scale")
    plt.savefig(output_path)
    plt.close()


def maybe_plot(overhead_rows, runtime_ratio_samples, output_dir):
    if overhead_rows.empty:
        return

    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib not installed; skipping plot generation.")
        return

    output_dir.mkdir(parents=True, exist_ok=True)
    wall_ratios = overhead_rows["wall_ratio"]

    plot_runtime_overhead_boxplot(
        plt,
        runtime_ratio_samples,
        overhead_rows,
        output_dir / "runtime_overhead.png",
    )

    plot_labeled_scatter(
        plt,
        overhead_rows["crossing_count"],
        wall_ratios,
        overhead_rows["library"],
        "Median Crossing Count",
        "Sandbox / Native Runtime Ratio",
        "Overhead vs Crossing Count",
        output_dir / "overhead_vs_crossing_count.png",
    )

    plot_labeled_scatter(
        plt,
        overhead_rows["crossing_total_bytes"],
        wall_ratios,
        overhead_rows["library"],
        "Total Crossing Bytes",
        "Sandbox / Native Runtime Ratio",
        "Overhead vs Total Crossing Bytes",
        output_dir / "overhead_vs_crossing_bytes.png",
    )

    plot_labeled_scatter(
        plt,
        overhead_rows["crossing_count"],
        overhead_rows["peak_heap_delta_mb"],
        overhead_rows["library"],
        "Median Crossing Count",
        "Peak Heap Delta (MB)",
        "Peak Heap Delta vs Crossing Count",
        output_dir / "heap_delta_vs_crossing_count.png",
    )

    plot_labeled_scatter(
        plt,
        overhead_rows["crossing_total_bytes"],
        overhead_rows["peak_heap_delta_mb"],
        overhead_rows["library"],
        "Total Crossing Bytes",
        "Peak Heap Delta (MB)",
        "Peak Heap Delta vs Total Crossing Bytes",
        output_dir / "heap_delta_vs_crossing_bytes.png",
    )


def main():
    parser = argparse.ArgumentParser(description="Analyze sandbox performance CSV outputs.")
    parser.add_argument(
        "--results-dir",
        default="performance-harness/results",
        help="Directory containing runs.csv, events.csv, and crossings.csv",
    )
    parser.add_argument(
        "--plots-dir",
        default=None,
        help="Directory for generated plots",
    )
    args = parser.parse_args()

    results_dir = Path(args.results_dir)
    plots_dir = Path(args.plots_dir) if args.plots_dir else results_dir / "plots"
    runs = prepare_runs(load_csv(results_dir / "runs.csv"))
    events = load_csv(results_dir / "events.csv")
    crossings = load_csv(results_dir / "crossings.csv")

    measured_runs = runs[
        (~runs["warmup"]) & runs["completed"] & (runs["exit_code"] == 0)
    ]
    summaries = summarize_runs(measured_runs)
    sandbox_details = summarize_sandbox_details(measured_runs, events, crossings)
    overhead_rows = build_overhead_rows(summaries, sandbox_details)
    runtime_ratio_samples = build_runtime_ratio_samples(measured_runs)

    print("Median runtime summaries:")
    for row in summaries.itertuples():
        prefix = (
            f"- {row.environment}:{row.library}:{row.workload_id}:"
            f"reps={row.repetitions:.0f}:{row.mode} wall={row.wall_ms:.2f}ms "
        )
        if row.environment == "browser":
            print(
                prefix
                + f"elapsed={row.browser_elapsed_ms:.2f}ms "
                + f"task={row.browser_task_ms:.2f}ms "
                + f"script={row.browser_script_ms:.2f}ms "
                + f"peak_heap={row.peak_heap_used_mb:.2f}MB"
            )
        else:
            print(
                prefix
                + f"cpu={row.cpu_user_ms + row.cpu_system_ms:.2f}ms "
                + f"peak_rss={row.peak_rss_mb:.2f}MB"
            )

    print("\nOverhead summaries:")
    for row in overhead_rows.itertuples():
        browser_ratios = ""
        if (
            row.environment == "browser"
            and not math.isnan(row.browser_elapsed_ratio)
            and not math.isnan(row.browser_task_ratio)
        ):
            browser_ratios = (
                f"browser_elapsed_ratio={row.browser_elapsed_ratio:.3f} "
                f"browser_task_ratio={row.browser_task_ratio:.3f} "
            )
        print(
            f"- {row.environment}:{row.library}:{row.workload_id}:"
            f"reps={row.repetitions:.0f} "
            f"wall_ratio={row.wall_ratio:.3f} "
            f"{browser_ratios}"
            f"heap_delta={row.peak_heap_delta_mb:.2f}MB "
            f"heap_ratio={row.peak_heap_ratio:.3f} "
            f"crossings={row.crossing_count:.0f} "
            f"median_size={row.crossing_size_median_bytes:.0f}B"
        )

    browser_rows = overhead_rows[overhead_rows["environment"] == "browser"]
    if not browser_rows.empty:
        print("\nBrowser summaries:")
        for row in browser_rows.itertuples():
            print(
                f"- {row.library}:{row.workload_id}:"
                f"reps={row.repetitions:.0f} "
                f"webapi_expose_ms={row.webapi_expose_ms:.2f} "
                f"webapi_exposed_count={row.webapi_exposed_count:.0f}"
            )

    if not overhead_rows.empty:
        print_correlations(overhead_rows)

    maybe_plot(overhead_rows, runtime_ratio_samples, plots_dir)


if __name__ == "__main__":
    main()
