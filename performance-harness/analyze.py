#!/usr/bin/env python3
import argparse
import csv
import math
from collections import defaultdict
from pathlib import Path
from statistics import median


NUMERIC_FIELDS = {
    "wall_ms",
    "cpu_user_ms",
    "cpu_system_ms",
    "peak_rss_mb",
    "peak_heap_used_mb",
    "peak_external_mb",
    "final_rss_mb",
    "final_heap_used_mb",
    "final_external_mb",
    "exit_code",
    "sandbox_create_ms",
    "bundle_eval_ms",
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


def parse_value(key, value):
    if key in {"warmup", "completed"}:
        return value.lower() == "true"
    if key in NUMERIC_FIELDS:
        if value == "":
            return 0.0
        return float(value)
    return value


def load_csv(path):
    if not path.exists():
        return []
    with path.open("r", encoding="utf8", newline="") as handle:
        reader = csv.DictReader(handle)
        return [
            {key: parse_value(key, value) for key, value in row.items()}
            for row in reader
        ]


def group_runs(runs):
    grouped = defaultdict(list)
    for row in runs:
        key = (row["library"], row["workload_id"], row["mode"])
        grouped[key].append(row)
    return grouped


def summarize_runs(grouped):
    summaries = []
    metrics = [
        "wall_ms",
        "cpu_user_ms",
        "cpu_system_ms",
        "peak_rss_mb",
        "peak_heap_used_mb",
        "peak_external_mb",
        "final_rss_mb",
        "final_heap_used_mb",
        "final_external_mb",
    ]

    for (library, workload_id, mode), rows in grouped.items():
        summary = {
            "library": library,
            "workload_id": workload_id,
            "mode": mode,
            "runs": len(rows),
        }
        for metric in metrics:
            summary[metric] = median(row[metric] for row in rows)
        summaries.append(summary)

    return summaries


def build_overhead_rows(summaries, sandbox_details):
    keyed = defaultdict(dict)
    for row in summaries:
        keyed[(row["library"], row["workload_id"])][row["mode"]] = row

    overhead_rows = []
    for key, modes in keyed.items():
        native = modes.get("native")
        sandbox = modes.get("sandbox")
        if not native or not sandbox:
            continue

        library, workload_id = key
        wall_ratio = (
            sandbox["wall_ms"] / native["wall_ms"] if native["wall_ms"] else math.nan
        )
        overhead = {
            "library": library,
            "workload_id": workload_id,
            "wall_ratio": wall_ratio,
            "wall_delta_ms": sandbox["wall_ms"] - native["wall_ms"],
            "cpu_delta_ms": (
                sandbox["cpu_user_ms"]
                + sandbox["cpu_system_ms"]
                - native["cpu_user_ms"]
                - native["cpu_system_ms"]
            ),
            "rss_delta_mb": sandbox["peak_rss_mb"] - native["peak_rss_mb"],
        }
        overhead.update(sandbox_details.get(key, {}))
        overhead_rows.append(overhead)

    return overhead_rows


def summarize_sandbox_details(runs, events, crossings):
    events_by_run = {row["run_id"]: row for row in events}
    crossings_by_run = {row["run_id"]: row for row in crossings}
    grouped = defaultdict(list)

    for run in runs:
        if run["mode"] != "sandbox":
            continue
        key = (run["library"], run["workload_id"])
        grouped[key].append(
            {
                **events_by_run.get(run["run_id"], {}),
                **crossings_by_run.get(run["run_id"], {}),
            }
        )

    summary = {}
    for key, rows in grouped.items():
        summary[key] = {
            "membrane_call_count": median(row.get("membrane_call_count", 0) for row in rows),
            "membrane_call_ms": median(row.get("membrane_call_ms", 0) for row in rows),
            "crossing_count": median(
                row.get("host_to_vm_count", 0) + row.get("vm_to_host_count", 0)
                for row in rows
            ),
            "crossing_size_median_bytes": median(
                row.get("crossing_size_median_bytes", 0) for row in rows
            ),
            "crossing_size_p95_bytes": median(
                row.get("crossing_size_p95_bytes", 0) for row in rows
            ),
            "crossing_total_bytes": median(
                row.get("host_to_vm_total_bytes", 0) + row.get("vm_to_host_total_bytes", 0)
                for row in rows
            ),
        }

    return summary


def spearman(xs, ys):
    if len(xs) < 2 or len(xs) != len(ys):
        return math.nan

    def rank(values):
        ordered = sorted((value, index) for index, value in enumerate(values))
        ranks = [0.0] * len(values)
        current = 0
        while current < len(ordered):
            end = current
            while end < len(ordered) and ordered[end][0] == ordered[current][0]:
                end += 1
            average_rank = (current + end - 1) / 2 + 1
            for _, index in ordered[current:end]:
                ranks[index] = average_rank
            current = end
        return ranks

    rx = rank(xs)
    ry = rank(ys)
    mean_rx = sum(rx) / len(rx)
    mean_ry = sum(ry) / len(ry)
    numerator = sum((x - mean_rx) * (y - mean_ry) for x, y in zip(rx, ry))
    denominator_x = math.sqrt(sum((x - mean_rx) ** 2 for x in rx))
    denominator_y = math.sqrt(sum((y - mean_ry) ** 2 for y in ry))
    if denominator_x == 0 or denominator_y == 0:
        return math.nan
    return numerator / (denominator_x * denominator_y)


def maybe_plot(overhead_rows, output_dir):
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib not installed; skipping plot generation.")
        return

    output_dir.mkdir(parents=True, exist_ok=True)
    labels = [f'{row["library"]}:{row["workload_id"]}' for row in overhead_rows]
    wall_ratios = [row["wall_ratio"] for row in overhead_rows]

    plt.figure(figsize=(12, 6))
    plt.bar(labels, wall_ratios)
    plt.xticks(rotation=45, ha="right")
    plt.ylabel("Sandbox / Native Runtime Ratio")
    plt.title("Runtime Overhead by Workload")
    plt.tight_layout()
    plt.savefig(output_dir / "runtime_overhead.png")
    plt.close()

    plt.figure(figsize=(8, 6))
    plt.scatter(
        [row.get("crossing_count", 0) for row in overhead_rows],
        wall_ratios,
    )
    plt.xlabel("Median Crossing Count")
    plt.ylabel("Sandbox / Native Runtime Ratio")
    plt.title("Overhead vs Crossing Count")
    plt.tight_layout()
    plt.savefig(output_dir / "overhead_vs_crossing_count.png")
    plt.close()

    plt.figure(figsize=(8, 6))
    plt.scatter(
        [row.get("crossing_size_median_bytes", 0) for row in overhead_rows],
        wall_ratios,
    )
    plt.xlabel("Median Crossing Size (bytes)")
    plt.ylabel("Sandbox / Native Runtime Ratio")
    plt.title("Overhead vs Median Crossing Size")
    plt.tight_layout()
    plt.savefig(output_dir / "overhead_vs_crossing_size.png")
    plt.close()


def main():
    parser = argparse.ArgumentParser(description="Analyze sandbox performance CSV outputs.")
    parser.add_argument(
        "--results-dir",
        default="performance-harness/results",
        help="Directory containing runs.csv, events.csv, and crossings.csv",
    )
    parser.add_argument(
        "--plots-dir",
        default="performance-harness/results/plots",
        help="Directory for generated plots",
    )
    args = parser.parse_args()

    results_dir = Path(args.results_dir)
    runs = load_csv(results_dir / "runs.csv")
    events = load_csv(results_dir / "events.csv")
    crossings = load_csv(results_dir / "crossings.csv")

    measured_runs = [
        row
        for row in runs
        if not row.get("warmup", False)
        and row.get("completed", True)
        and row.get("exit_code", 1) == 0
    ]
    grouped = group_runs(measured_runs)
    summaries = summarize_runs(grouped)
    sandbox_details = summarize_sandbox_details(measured_runs, events, crossings)
    overhead_rows = build_overhead_rows(summaries, sandbox_details)

    print("Median runtime summaries:")
    for row in summaries:
        print(
            f'- {row["library"]}:{row["workload_id"]}:{row["mode"]} '
            f'wall={row["wall_ms"]:.2f}ms '
            f'cpu={row["cpu_user_ms"] + row["cpu_system_ms"]:.2f}ms '
            f'peak_rss={row["peak_rss_mb"]:.2f}MB'
        )

    print("\nOverhead summaries:")
    for row in overhead_rows:
        print(
            f'- {row["library"]}:{row["workload_id"]} '
            f'wall_ratio={row["wall_ratio"]:.3f} '
            f'crossings={row.get("crossing_count", 0):.0f} '
            f'median_size={row.get("crossing_size_median_bytes", 0):.0f}B'
        )

    if overhead_rows:
        wall_ratios = [row["wall_ratio"] for row in overhead_rows]
        print("\nSpearman correlations:")
        print(
            "  overhead vs crossing count:",
            f'{spearman([row.get("crossing_count", 0) for row in overhead_rows], wall_ratios):.3f}',
        )
        print(
            "  overhead vs median crossing size:",
            f'{spearman([row.get("crossing_size_median_bytes", 0) for row in overhead_rows], wall_ratios):.3f}',
        )
        print(
            "  overhead vs p95 crossing size:",
            f'{spearman([row.get("crossing_size_p95_bytes", 0) for row in overhead_rows], wall_ratios):.3f}',
        )
        print(
            "  overhead vs total crossing bytes:",
            f'{spearman([row.get("crossing_total_bytes", 0) for row in overhead_rows], wall_ratios):.3f}',
        )

    maybe_plot(overhead_rows, Path(args.plots_dir))


if __name__ == "__main__":
    main()
