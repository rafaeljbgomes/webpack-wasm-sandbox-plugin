#!/usr/bin/env python3
import argparse
import math
from pathlib import Path

import numpy as np
import pandas as pd


GROUP_COLUMNS = [
    "environment",
    "library",
    "workload_id",
    "scenario_variant",
    "repetitions",
]
BOOTSTRAP_SAMPLES = 10_000
BOOTSTRAP_SEED = 20260612
DISTRIBUTION_MAIN_AXIS_MAX = 100.0
WORKLOAD_ADAPTER_PLOT_EXCLUDED_LIBRARIES = {"luxon", "image-js"}

EVENT_METRICS = [
    "sandbox_create_ms",
    "bundle_eval_ms",
    "workload_bundle_eval_ms",
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
]
CROSSING_BASE_METRICS = [
    "host_to_vm_count",
    "vm_to_host_count",
    "host_to_vm_total_bytes",
    "vm_to_host_total_bytes",
    "crossing_size_median_bytes",
    "crossing_size_p95_bytes",
    "crossing_size_max_bytes",
]
CROSSING_MEMBRANES = ["forward", "reverse"]
CROSSING_METRICS = [
    *CROSSING_BASE_METRICS,
    *[
        f"{membrane}_{metric}"
        for membrane in CROSSING_MEMBRANES
        for metric in CROSSING_BASE_METRICS
    ],
]
SCENARIO_CUMULATIVE_METRICS = [
    *[metric for metric in EVENT_METRICS if metric != "temp_object_peak_count"],
    "host_to_vm_count",
    "vm_to_host_count",
    "host_to_vm_total_bytes",
    "vm_to_host_total_bytes",
    *[
        f"{membrane}_{metric}"
        for membrane in CROSSING_MEMBRANES
        for metric in [
            "host_to_vm_count",
            "vm_to_host_count",
            "host_to_vm_total_bytes",
            "vm_to_host_total_bytes",
        ]
    ],
]
SCENARIO_NON_NORMALIZED_METRICS = [
    "temp_object_peak_count",
    "crossing_size_median_bytes",
    "crossing_size_p95_bytes",
    "crossing_size_max_bytes",
    *[
        f"{membrane}_{metric}"
        for membrane in CROSSING_MEMBRANES
        for metric in [
            "crossing_size_median_bytes",
            "crossing_size_p95_bytes",
            "crossing_size_max_bytes",
        ]
    ],
]
DERIVED_METRICS = [
    "marshalling_count",
    "marshalling_ms",
    "marshal_avg_ms",
    "unmarshal_avg_ms",
    "marshalling_avg_ms",
    "crossing_count",
    "crossing_total_bytes",
    "forward_crossing_count",
    "forward_crossing_total_bytes",
    "reverse_crossing_count",
    "reverse_crossing_total_bytes",
]

RUN_METRICS = [
    "scenario_total_ms",
    "scenario_ms",
    "completed_repetitions",
    "peak_heap_used_mb",
    "final_heap_used_mb",
    "browser_elapsed_ms",
    "browser_non_scenario_ms",
    "browser_task_ms",
    "browser_script_ms",
]
REQUIRED_RUN_COLUMNS = {
    "run_id",
    "library",
    "workload_id",
    "scenario_variant",
    "mode",
    "iteration",
    "warmup",
    "completed",
    "exit_code",
    "environment",
    "repetitions",
    *RUN_METRICS,
}
REQUIRED_EVENT_COLUMNS = {
    "run_id",
    *EVENT_METRICS,
    *[f"{phase}_{metric}" for phase in ["startup", "scenario"] for metric in EVENT_METRICS],
}
REQUIRED_CROSSING_COLUMNS = {
    "run_id",
    *CROSSING_METRICS,
    *[
        f"{phase}_{metric}"
        for phase in ["startup", "scenario"]
        for metric in CROSSING_METRICS
    ],
}
NUMERIC_FIELDS = {
    "iteration",
    "exit_code",
    "repetitions",
    *RUN_METRICS,
    *EVENT_METRICS,
    *CROSSING_METRICS,
    *[f"{phase}_{metric}" for phase in ["startup", "scenario"] for metric in EVENT_METRICS],
    *[
        f"{phase}_{metric}"
        for phase in ["startup", "scenario"]
        for metric in CROSSING_METRICS
    ],
}
SANDBOX_DETAIL_METRICS = [
    *EVENT_METRICS,
    *CROSSING_METRICS,
    *DERIVED_METRICS,
    *[f"startup_{metric}" for metric in [*EVENT_METRICS, *CROSSING_METRICS, *DERIVED_METRICS]],
    *[
        f"scenario_{metric}"
        for metric in [*EVENT_METRICS, *CROSSING_METRICS, *DERIVED_METRICS]
    ],
]

CORRELATION_INPUTS = [
    ("crossing count", "scenario_crossing_count"),
    ("median crossing size", "scenario_crossing_size_median_bytes"),
    ("p95 crossing size", "scenario_crossing_size_p95_bytes"),
    ("total crossing bytes", "scenario_crossing_total_bytes"),
    ("marshalling count", "scenario_marshalling_count"),
    ("marshalling time", "scenario_marshalling_ms"),
    ("host->VM crossings", "scenario_host_to_vm_count"),
    ("VM->host crossings", "scenario_vm_to_host_count"),
    ("host->VM bytes", "scenario_host_to_vm_total_bytes"),
    ("VM->host bytes", "scenario_vm_to_host_total_bytes"),
    ("forward crossing count", "scenario_forward_crossing_count"),
    ("forward crossing bytes", "scenario_forward_crossing_total_bytes"),
    ("reverse crossing count", "scenario_reverse_crossing_count"),
    ("reverse crossing bytes", "scenario_reverse_crossing_total_bytes"),
]


def load_csv(path, required_columns):
    if not path.exists():
        raise ValueError(f"Required CSV file does not exist: {path}")

    frame = pd.read_csv(path)
    missing = sorted(required_columns.difference(frame.columns))
    if missing:
        raise ValueError(
            f"{path} uses an unsupported schema; missing columns: {', '.join(missing)}"
        )

    for column in NUMERIC_FIELDS.intersection(frame.columns):
        frame[column] = pd.to_numeric(frame[column], errors="coerce").fillna(0.0)
    for column in ["warmup", "completed"]:
        if column in frame.columns:
            frame[column] = frame[column].astype(str).str.lower().eq("true")
    return frame


def zero_safe_divide(numerator, denominator):
    return numerator / denominator.replace(0, math.nan)


def add_derived_metrics(frame, prefix=""):
    column_prefix = f"{prefix}_" if prefix else ""
    derived = {
        f"{column_prefix}marshalling_count": (
            frame[f"{column_prefix}marshal_count"]
            + frame[f"{column_prefix}unmarshal_count"]
        ),
        f"{column_prefix}marshalling_ms": (
            frame[f"{column_prefix}marshal_ms"]
            + frame[f"{column_prefix}unmarshal_ms"]
        ),
        f"{column_prefix}marshal_avg_ms": zero_safe_divide(
            frame[f"{column_prefix}marshal_ms"],
            frame[f"{column_prefix}marshal_count"],
        ),
        f"{column_prefix}unmarshal_avg_ms": zero_safe_divide(
            frame[f"{column_prefix}unmarshal_ms"],
            frame[f"{column_prefix}unmarshal_count"],
        ),
    }
    derived[f"{column_prefix}marshalling_avg_ms"] = zero_safe_divide(
        derived[f"{column_prefix}marshalling_ms"],
        derived[f"{column_prefix}marshalling_count"],
    )
    derived[f"{column_prefix}crossing_count"] = (
        frame[f"{column_prefix}host_to_vm_count"]
        + frame[f"{column_prefix}vm_to_host_count"]
    )
    derived[f"{column_prefix}crossing_total_bytes"] = (
        frame[f"{column_prefix}host_to_vm_total_bytes"]
        + frame[f"{column_prefix}vm_to_host_total_bytes"]
    )
    for membrane in CROSSING_MEMBRANES:
        derived[f"{column_prefix}{membrane}_crossing_count"] = (
            frame[f"{column_prefix}{membrane}_host_to_vm_count"]
            + frame[f"{column_prefix}{membrane}_vm_to_host_count"]
        )
        derived[f"{column_prefix}{membrane}_crossing_total_bytes"] = (
            frame[f"{column_prefix}{membrane}_host_to_vm_total_bytes"]
            + frame[f"{column_prefix}{membrane}_vm_to_host_total_bytes"]
        )
    return pd.concat([frame, pd.DataFrame(derived, index=frame.index)], axis=1)


def summarize_runs(runs):
    grouped = runs.groupby([*GROUP_COLUMNS, "mode"], sort=False, dropna=False)
    summaries = grouped[RUN_METRICS].median().reset_index()
    summaries["runs"] = grouped.size().to_numpy()
    return summaries[[*GROUP_COLUMNS, "mode", "runs", *RUN_METRICS]]


def summarize_sandbox_details(runs, events, crossings):
    sandbox_runs = runs[runs["mode"] == "sandbox"]
    details = sandbox_runs[["run_id", *GROUP_COLUMNS]].copy()
    details = details.merge(events, on="run_id", how="left")
    details = details.merge(crossings, on="run_id", how="left")

    metric_columns = [
        *EVENT_METRICS,
        *CROSSING_METRICS,
        *[f"startup_{metric}" for metric in [*EVENT_METRICS, *CROSSING_METRICS]],
        *[f"scenario_{metric}" for metric in [*EVENT_METRICS, *CROSSING_METRICS]],
    ]
    for column in metric_columns:
        details[column] = pd.to_numeric(details[column], errors="coerce").fillna(0.0)

    for metric in SCENARIO_CUMULATIVE_METRICS:
        details[f"scenario_{metric}"] = zero_safe_divide(
            details[f"scenario_{metric}"],
            details["repetitions"],
        )
    for metric in SCENARIO_NON_NORMALIZED_METRICS:
        details[f"scenario_{metric}"] = details[f"scenario_{metric}"]

    details = add_derived_metrics(details)
    details = add_derived_metrics(details, "startup")
    details = add_derived_metrics(details, "scenario")
    details = details.copy()

    return (
        details.groupby(GROUP_COLUMNS, sort=False, dropna=False)[SANDBOX_DETAIL_METRICS]
        .median()
        .reset_index()
    )


def bootstrap_ratio(native_values, sandbox_values, rng):
    native = np.asarray(native_values, dtype=float)
    sandbox = np.asarray(sandbox_values, dtype=float)
    native = native[np.isfinite(native) & (native > 0)]
    sandbox = sandbox[np.isfinite(sandbox)]
    if native.size == 0 or sandbox.size == 0:
        return math.nan, math.nan, math.nan, np.array([], dtype=float)

    native_samples = rng.choice(
        native,
        size=(BOOTSTRAP_SAMPLES, native.size),
        replace=True,
    )
    sandbox_samples = rng.choice(
        sandbox,
        size=(BOOTSTRAP_SAMPLES, sandbox.size),
        replace=True,
    )
    ratios = np.median(sandbox_samples, axis=1) / np.median(native_samples, axis=1)
    ratio = float(np.median(sandbox) / np.median(native))
    ci_low, ci_high = np.percentile(ratios, [2.5, 97.5])
    return ratio, float(ci_low), float(ci_high), ratios


def build_overhead_rows(runs, summaries, sandbox_details):
    rng = np.random.default_rng(BOOTSTRAP_SEED)
    rows = []
    distributions = []

    grouped = runs.groupby(GROUP_COLUMNS, sort=True, dropna=False)
    for group_key, group in grouped:
        native_runs = group[group["mode"] == "native"]
        sandbox_runs = group[group["mode"] == "sandbox"]
        if native_runs.empty or sandbox_runs.empty:
            continue

        scenario_ratio, ci_low, ci_high, samples = bootstrap_ratio(
            native_runs["scenario_ms"],
            sandbox_runs["scenario_ms"],
            rng,
        )
        non_scenario_ratio, non_scenario_ci_low, non_scenario_ci_high, _ = bootstrap_ratio(
            native_runs["browser_non_scenario_ms"],
            sandbox_runs["browser_non_scenario_ms"],
            rng,
        )
        row = dict(zip(GROUP_COLUMNS, group_key))
        row.update(
            {
                "scenario_ratio": scenario_ratio,
                "scenario_ratio_ci_low": ci_low,
                "scenario_ratio_ci_high": ci_high,
                "browser_non_scenario_ratio": non_scenario_ratio,
                "browser_non_scenario_ratio_ci_low": non_scenario_ci_low,
                "browser_non_scenario_ratio_ci_high": non_scenario_ci_high,
            }
        )
        for sample_index, value in enumerate(samples):
            distributions.append(
                {
                    **dict(zip(GROUP_COLUMNS, group_key)),
                    "sample_index": sample_index,
                    "scenario_ratio": value,
                }
            )
        rows.append(row)

    overhead = pd.DataFrame(rows)
    if overhead.empty:
        return overhead, pd.DataFrame(distributions)

    native = summaries[summaries["mode"] == "native"]
    sandbox = summaries[summaries["mode"] == "sandbox"]
    timing = sandbox.merge(
        native,
        on=GROUP_COLUMNS,
        how="inner",
        suffixes=("_sandbox", "_native"),
    )
    timing["scenario_delta_ms"] = (
        timing["scenario_ms_sandbox"] - timing["scenario_ms_native"]
    )
    timing["browser_non_scenario_delta_ms"] = (
        timing["browser_non_scenario_ms_sandbox"]
        - timing["browser_non_scenario_ms_native"]
    )
    timing["peak_heap_sandbox_mb"] = timing["peak_heap_used_mb_sandbox"]
    timing["peak_heap_native_mb"] = timing["peak_heap_used_mb_native"]
    timing["peak_heap_delta_mb"] = (
        timing["peak_heap_sandbox_mb"] - timing["peak_heap_native_mb"]
    )
    timing["peak_heap_ratio"] = zero_safe_divide(
        timing["peak_heap_sandbox_mb"],
        timing["peak_heap_native_mb"],
    )

    timing_columns = [
        *GROUP_COLUMNS,
        "scenario_total_ms_native",
        "scenario_total_ms_sandbox",
        "scenario_ms_native",
        "scenario_ms_sandbox",
        "scenario_delta_ms",
        "browser_elapsed_ms_native",
        "browser_elapsed_ms_sandbox",
        "browser_non_scenario_ms_native",
        "browser_non_scenario_ms_sandbox",
        "browser_non_scenario_delta_ms",
        "peak_heap_sandbox_mb",
        "peak_heap_native_mb",
        "peak_heap_delta_mb",
        "peak_heap_ratio",
    ]
    overhead = overhead.merge(timing[timing_columns], on=GROUP_COLUMNS, how="left")
    overhead = overhead.merge(sandbox_details, on=GROUP_COLUMNS, how="left")
    return overhead, pd.DataFrame(distributions)


def spearman(xs, ys):
    values = pd.DataFrame({"x": xs, "y": ys}).replace([math.inf, -math.inf], pd.NA)
    values = values.apply(pd.to_numeric, errors="coerce").dropna()
    if len(values) < 2 or values["x"].nunique() < 2 or values["y"].nunique() < 2:
        return math.nan
    ranks = values.rank(method="average")
    return ranks["x"].corr(ranks["y"], method="pearson")


def print_correlations(overhead_rows):
    print("\nSpearman runtime overhead correlations:")
    for input_label, input_column in CORRELATION_INPUTS:
        print(
            f"  scenario overhead vs {input_label}:",
            f"{spearman(overhead_rows[input_column], overhead_rows['scenario_ratio']):.3f}",
        )

    print("\nSpearman memory overhead correlations:")
    for input_label, input_column in CORRELATION_INPUTS:
        print(
            f"  peak heap ratio vs {input_label}:",
            f"{spearman(overhead_rows[input_column], overhead_rows['peak_heap_ratio']):.3f}",
        )


def workload_label(row):
    return f"{row.library}:{row.workload_id}:reps={row.repetitions:.0f}"


def plot_labeled_scatter(plt, rows, x_column, y_column, xlabel, ylabel, title, path):
    if rows.empty:
        return

    plt.figure(figsize=(10, 7))
    plt.scatter(rows[x_column], rows[y_column])
    for index, row in enumerate(rows.itertuples()):
        x_offset = 6 if index % 2 == 0 else -6
        y_offset = 6 if (index // 2) % 2 == 0 else -6
        plt.annotate(
            row.library,
            (getattr(row, x_column), getattr(row, y_column)),
            textcoords="offset points",
            xytext=(x_offset, y_offset),
            ha="left" if x_offset > 0 else "right",
            va="bottom" if y_offset > 0 else "top",
            fontsize=8,
            bbox={"boxstyle": "round,pad=0.2", "fc": "white", "alpha": 0.7, "lw": 0},
        )
    plt.xlabel(xlabel)
    plt.ylabel(ylabel)
    plt.title(title)
    plt.tight_layout()
    plt.savefig(path)
    plt.close()


def plot_runtime_overhead(plt, rows, output_path):
    if rows.empty:
        return

    rows = rows.sort_values("scenario_ratio", ascending=False)
    positions = np.arange(len(rows))
    values = rows["scenario_ratio"].to_numpy()
    errors = np.vstack(
        [
            np.maximum(0.0, values - rows["scenario_ratio_ci_low"].to_numpy()),
            np.maximum(0.0, rows["scenario_ratio_ci_high"].to_numpy() - values),
        ]
    )
    plt.figure(figsize=(max(10, len(rows) * 1.1), 7))
    bars = plt.bar(positions, values, yerr=errors, capsize=4, color="#2f5f98")
    plt.axhline(1.0, color="#666666", linestyle="--", linewidth=1)
    plt.xticks(positions, rows["library"], rotation=45, ha="right")
    plt.ylabel("Razão entre o cenário em sandbox e nativo")
    plt.title("Sobrecusto mediano do cenário por biblioteca")
    plt.bar_label(bars, labels=[f"{value:.2f}x" for value in values], padding=3)
    plt.margins(y=0.12)
    plt.tight_layout()
    plt.savefig(output_path)
    plt.close()


def distribution_axis_limits(values):
    q1, q3 = values.quantile([0.25, 0.75])
    ci_low, ci_high = values.quantile([0.025, 0.975])
    iqr = q3 - q1
    whisker_low = max(values.min(), q1 - 1.5 * iqr)
    whisker_high = min(values.max(), q3 + 1.5 * iqr)
    lower = min(ci_low, whisker_low)
    upper = max(ci_high, whisker_high)
    span = upper - lower
    padding = span * 0.18 if span > 0 else max(abs(lower) * 0.05, 0.05)
    return lower - padding, upper + padding


def plot_distribution_panels(plt, groups, output_dir, filename_prefix, axis_limits, title_note):
    for panel_index, start in enumerate(range(0, len(groups), 6), start=1):
        panel_groups = groups[start : start + 6]
        figure, axes = plt.subplots(
            3,
            2,
            figsize=(11, 13.5),
            sharey=True,
            constrained_layout=True,
        )
        figure.suptitle(
            f"Distribuições bootstrap do sobrecusto dos cenários ({title_note})",
            fontsize=14,
        )
        figure.supylabel("Razão entre o cenário em sandbox e nativo")

        for axis, item in zip(axes.flat, panel_groups):
            axis.boxplot(
                [item["values"]],
                tick_labels=[""],
                widths=0.35,
                patch_artist=True,
                showfliers=False,
                boxprops={"facecolor": "#d9e8fb", "edgecolor": "#2f5f98"},
                medianprops={"color": "#111111", "linewidth": 1.6},
                whiskerprops={"color": "#2f5f98"},
                capprops={"color": "#2f5f98"},
            )
            axis.set_ylim(*axis_limits)
            axis.set_title(f"{item['library']} · {item['workload_id']}", fontsize=11)
            axis.text(
                0.5,
                0.97,
                (
                    f"Mediana = {item['median']:.2f}x\n"
                    f"IC 95% = {item['ci_low']:.2f}–{item['ci_high']:.2f}x"
                ),
                transform=axis.transAxes,
                ha="center",
                va="top",
                fontsize=9,
                bbox={
                    "boxstyle": "round,pad=0.25",
                    "fc": "white",
                    "alpha": 0.85,
                    "lw": 0,
                },
            )
            axis.tick_params(axis="x", bottom=False)
            axis.grid(axis="y", alpha=0.25)

        for axis in axes.flat[len(panel_groups) :]:
            axis.set_visible(False)

        figure.savefig(
            output_dir / f"{filename_prefix}_{panel_index:02d}.png",
            dpi=150,
        )
        plt.close()


def plot_runtime_distributions(plt, distributions, output_dir):
    if distributions.empty:
        return

    output_dir.mkdir(parents=True, exist_ok=True)
    for existing_plot in output_dir.glob("*.png"):
        existing_plot.unlink()

    groups = []
    for group_key, group in distributions.groupby(GROUP_COLUMNS, sort=False):
        environment, library, workload_id, variant, repetitions = group_key
        values = group["scenario_ratio"].dropna()
        if values.empty:
            continue
        median = values.median()
        ci_low, ci_high = values.quantile([0.025, 0.975])
        groups.append(
            {
                "library": library,
                "workload_id": workload_id,
                "values": values,
                "median": median,
                "ci_low": ci_low,
                "ci_high": ci_high,
                "axis_limits": distribution_axis_limits(values),
            }
        )

    groups.sort(key=lambda item: item["median"], reverse=True)
    if not groups:
        return

    main_groups = [
        item for item in groups if item["axis_limits"][1] <= DISTRIBUTION_MAIN_AXIS_MAX
    ]
    outlier_groups = [
        item for item in groups if item["axis_limits"][1] > DISTRIBUTION_MAIN_AXIS_MAX
    ]

    if main_groups:
        plot_distribution_panels(
            plt,
            main_groups,
            output_dir,
            "distribuicao_overhead",
            (0.0, DISTRIBUTION_MAIN_AXIS_MAX),
            f"escala comum até {DISTRIBUTION_MAIN_AXIS_MAX:.0f}x",
        )

    if outlier_groups:
        outlier_axis_limits = (
            min(0.0, min(item["axis_limits"][0] for item in outlier_groups)),
            max(item["axis_limits"][1] for item in outlier_groups),
        )
        plot_distribution_panels(
            plt,
            outlier_groups,
            output_dir,
            "distribuicao_overhead_outliers",
            outlier_axis_limits,
            f"outliers acima de {DISTRIBUTION_MAIN_AXIS_MAX:.0f}x",
        )


def plot_browser_breakdown(plt, rows, output_path):
    if rows.empty:
        return

    labels = [workload_label(row) for row in rows.itertuples()]
    scenario_values = rows["scenario_total_ms_sandbox"].to_numpy()
    residual_values = rows["browser_non_scenario_ms_sandbox"].to_numpy()
    positions = np.arange(len(rows))

    plt.figure(figsize=(max(12, len(rows) * 1.2), 7))
    plt.bar(positions, scenario_values, label="Lote de cenários", color="#2563eb")
    plt.bar(
        positions,
        residual_values,
        bottom=scenario_values,
        label="Browser fora do cenário",
        color="#d97706",
    )
    plt.xticks(positions, labels, rotation=45, ha="right", fontsize=8)
    plt.ylabel("Tempo da iteração em sandbox no browser (ms)")
    plt.title("Tempo do cenário e tempo restante no browser em sandbox")
    plt.legend()
    plt.tight_layout()
    plt.savefig(output_path)
    plt.close()


def plot_workload_adapter_overhead(plt, rows, output_path):
    variants_by_library = rows.groupby("library")["scenario_variant"].agg(set)
    workload_libraries = sorted(
        library
        for library, variants in variants_by_library.items()
        if {"transparent", "workload"}.issubset(variants)
        and library not in WORKLOAD_ADAPTER_PLOT_EXCLUDED_LIBRARIES
    )
    comparison_rows = []
    for library in workload_libraries:
        for variant in ["transparent", "workload"]:
            match = rows[
                (rows["library"] == library)
                & (rows["scenario_variant"] == variant)
            ]
            if not match.empty:
                comparison_rows.append(match.iloc[0])
    if not comparison_rows:
        return

    comparison = pd.DataFrame(comparison_rows)
    positions = np.arange(len(workload_libraries))
    width = 0.36
    plt.figure(figsize=(max(8, len(workload_libraries) * 2.5), 7))

    for offset, variant, label, color in [
        (-width / 2, "transparent", "Sandbox transparente", "#2f5f98"),
        (width / 2, "workload", "Adaptador de workload", "#d97706"),
    ]:
        variant_rows = comparison[comparison["scenario_variant"] == variant].set_index("library")
        values = np.array(
            [variant_rows.loc[library, "scenario_ratio"] for library in workload_libraries]
        )
        lower = np.array(
            [variant_rows.loc[library, "scenario_ratio_ci_low"] for library in workload_libraries]
        )
        upper = np.array(
            [variant_rows.loc[library, "scenario_ratio_ci_high"] for library in workload_libraries]
        )
        bars = plt.bar(
            positions + offset,
            values,
            width,
            label=label,
            color=color,
            yerr=np.vstack(
                [
                    np.maximum(0.0, values - lower),
                    np.maximum(0.0, upper - values),
                ]
            ),
            capsize=4,
        )
        plt.bar_label(bars, labels=[f"{value:.2f}x" for value in values], padding=3)

    plt.axhline(1.0, color="#666666", linestyle="--", linewidth=1)
    plt.xticks(positions, workload_libraries)
    plt.ylabel("Razão entre o cenário em sandbox e nativo")
    plt.title("Sobrecusto da sandbox transparente e do adaptador de workload")
    plt.legend()
    plt.margins(y=0.15)
    plt.tight_layout()
    plt.savefig(output_path)
    plt.close()


def maybe_plot(overhead_rows, distributions, output_dir):
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
    transparent = overhead_rows[overhead_rows["scenario_variant"] == "transparent"]
    transparent_distributions = distributions[
        distributions["scenario_variant"] == "transparent"
    ]

    plot_runtime_overhead(plt, transparent, output_dir / "runtime_overhead.png")
    plot_runtime_distributions(
        plt,
        transparent_distributions,
        output_dir / "runtime_overhead_distributions",
    )
    plot_browser_breakdown(
        plt,
        transparent,
        output_dir / "sandbox_browser_time_breakdown.png",
    )
    plot_workload_adapter_overhead(
        plt,
        overhead_rows,
        output_dir / "workload_adapter_overhead.png",
    )

    plot_labeled_scatter(
        plt,
        transparent,
        "scenario_crossing_count",
        "scenario_ratio",
        "Mediana de transferências por cenário",
        "Razão entre o cenário em sandbox e nativo",
        "Sobrecusto do cenário em função do número de transferências",
        output_dir / "overhead_vs_crossing_count.png",
    )
    plot_labeled_scatter(
        plt,
        transparent,
        "scenario_crossing_total_bytes",
        "scenario_ratio",
        "Mediana de bytes transferidos por cenário",
        "Razão entre o cenário em sandbox e nativo",
        "Sobrecusto do cenário em função dos bytes transferidos",
        output_dir / "overhead_vs_crossing_bytes.png",
    )
    plot_labeled_scatter(
        plt,
        transparent,
        "scenario_marshalling_count",
        "scenario_ratio",
        "Mediana de operações de marshalling personalizado por cenário",
        "Razão entre o cenário em sandbox e nativo",
        "Sobrecusto do cenário em função das operações de marshalling",
        output_dir / "overhead_vs_marshalling_count.png",
    )
    plot_labeled_scatter(
        plt,
        transparent,
        "scenario_marshalling_ms",
        "scenario_ratio",
        "Mediana do tempo de marshalling personalizado por cenário (ms)",
        "Razão entre o cenário em sandbox e nativo",
        "Sobrecusto do cenário em função do tempo de marshalling",
        output_dir / "overhead_vs_marshalling_ms.png",
    )
    plot_labeled_scatter(
        plt,
        transparent,
        "scenario_crossing_count",
        "peak_heap_delta_mb",
        "Mediana de transferências por cenário",
        "Diferença do pico de heap (MB)",
        "Diferença do pico de heap em função do número de transferências",
        output_dir / "heap_delta_vs_crossing_count.png",
    )
    plot_labeled_scatter(
        plt,
        transparent,
        "scenario_crossing_total_bytes",
        "peak_heap_delta_mb",
        "Mediana de bytes transferidos por cenário",
        "Diferença do pico de heap (MB)",
        "Diferença do pico de heap em função dos bytes transferidos",
        output_dir / "heap_delta_vs_crossing_bytes.png",
    )
    plot_labeled_scatter(
        plt,
        transparent,
        "scenario_marshalling_count",
        "peak_heap_delta_mb",
        "Mediana de operações de marshalling personalizado por cenário",
        "Diferença do pico de heap (MB)",
        "Diferença do pico de heap em função das operações de marshalling",
        output_dir / "heap_delta_vs_marshalling_count.png",
    )
    plot_labeled_scatter(
        plt,
        transparent,
        "scenario_marshalling_ms",
        "peak_heap_delta_mb",
        "Mediana do tempo de marshalling personalizado por cenário (ms)",
        "Diferença do pico de heap (MB)",
        "Diferença do pico de heap em função do tempo de marshalling",
        output_dir / "heap_delta_vs_marshalling_ms.png",
    )

    for membrane in CROSSING_MEMBRANES:
        membrane_label = {
            "forward": "direta",
            "reverse": "inversa",
        }.get(membrane, membrane)
        for metric, metric_label, filename_label in [
            ("crossing_count", "valores transferidos", "crossing_count"),
            ("crossing_total_bytes", "bytes transferidos estimados", "crossing_bytes"),
        ]:
            column = f"scenario_{membrane}_{metric}"
            xlabel = (
                f"Mediana de {metric_label} pela membrana {membrane_label} por cenário"
            )
            plot_labeled_scatter(
                plt,
                transparent,
                column,
                "scenario_ratio",
                xlabel,
                "Razão entre o cenário em sandbox e nativo",
                (
                    "Sobrecusto do cenário em função de "
                    f"{metric_label} pela membrana {membrane_label}"
                ),
                output_dir / f"overhead_vs_{membrane}_{filename_label}.png",
            )
            plot_labeled_scatter(
                plt,
                transparent,
                column,
                "peak_heap_delta_mb",
                xlabel,
                "Diferença do pico de heap (MB)",
                (
                    "Diferença do pico de heap em função de "
                    f"{metric_label} pela membrana {membrane_label}"
                ),
                output_dir / f"heap_delta_vs_{membrane}_{filename_label}.png",
            )


def main():
    parser = argparse.ArgumentParser(
        description="Analyze browser sandbox scenario performance CSV outputs."
    )
    parser.add_argument(
        "--results-dir",
        default="performance-harness/results-browser-scenarios",
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
    runs = load_csv(results_dir / "runs.csv", REQUIRED_RUN_COLUMNS)
    events = load_csv(results_dir / "events.csv", REQUIRED_EVENT_COLUMNS)
    crossings = load_csv(results_dir / "crossings.csv", REQUIRED_CROSSING_COLUMNS)

    measured_runs = runs[
        (~runs["warmup"]) & runs["completed"] & (runs["exit_code"] == 0)
    ].copy()
    if measured_runs.empty:
        raise ValueError("No successful measured browser runs were found.")

    summaries = summarize_runs(measured_runs)
    sandbox_details = summarize_sandbox_details(measured_runs, events, crossings)
    overhead_rows, distributions = build_overhead_rows(
        measured_runs,
        summaries,
        sandbox_details,
    )

    print("Median browser scenario summaries:")
    for row in summaries.itertuples():
        print(
            f"- {row.library}:{row.workload_id}:{row.scenario_variant}:"
            f"reps={row.repetitions:.0f}:{row.mode} "
            f"scenario_total={row.scenario_total_ms:.2f}ms "
            f"scenario={row.scenario_ms:.2f}ms "
            f"browser_non_scenario={row.browser_non_scenario_ms:.2f}ms "
            f"elapsed={row.browser_elapsed_ms:.2f}ms "
            f"peak_heap={row.peak_heap_used_mb:.2f}MB"
        )

    print("\nOverhead summaries:")
    for row in overhead_rows.itertuples():
        print(
            f"- {row.library}:{row.workload_id}:{row.scenario_variant}:"
            f"reps={row.repetitions:.0f} "
            f"scenario_ratio={row.scenario_ratio:.3f} "
            f"scenario_ci95={row.scenario_ratio_ci_low:.3f}-{row.scenario_ratio_ci_high:.3f} "
            f"browser_non_scenario_ratio={row.browser_non_scenario_ratio:.3f} "
            f"scenario_delta={row.scenario_delta_ms:.2f}ms "
            f"browser_non_scenario_delta={row.browser_non_scenario_delta_ms:.2f}ms "
            f"heap_delta={row.peak_heap_delta_mb:.2f}MB "
            f"heap_ratio={row.peak_heap_ratio:.3f} "
            f"crossings_per_scenario={row.scenario_crossing_count:.1f} "
            f"bytes_per_scenario={row.scenario_crossing_total_bytes:.1f} "
            f"forward_crossings={row.scenario_forward_crossing_count:.1f} "
            f"forward_bytes={row.scenario_forward_crossing_total_bytes:.1f} "
            f"reverse_crossings={row.scenario_reverse_crossing_count:.1f} "
            f"reverse_bytes={row.scenario_reverse_crossing_total_bytes:.1f} "
            f"marshalling_per_scenario={row.scenario_marshalling_count:.1f}"
        )

    transparent = overhead_rows[
        overhead_rows["scenario_variant"] == "transparent"
    ]
    if not transparent.empty:
        print_correlations(transparent)

    maybe_plot(overhead_rows, distributions, plots_dir)


if __name__ == "__main__":
    main()
