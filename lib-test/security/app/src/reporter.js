function formatValue(value) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

export function renderScenarioResult(title, rows, details = []) {
  const passed = rows.every((row) => row.pass);
  const output = document.getElementById("output");

  if (!output) {
    throw new Error("Security scenario output element was not found.");
  }

  const heading = document.querySelector("h1");
  if (heading) {
    heading.textContent = title;
  }

  const summary = document.createElement("h2");
  summary.textContent = passed ? "PASS" : "FAIL";
  summary.style.color = passed ? "#137333" : "#b3261e";

  const table = document.createElement("table");
  table.style.borderCollapse = "collapse";
  table.style.width = "100%";

  const header = document.createElement("tr");
  for (const label of ["Observation", "Expected", "Observed", "Result"]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    cell.style.border = "1px solid #bbb";
    cell.style.padding = "8px";
    cell.style.textAlign = "left";
    header.appendChild(cell);
  }
  table.appendChild(header);

  for (const row of rows) {
    const tableRow = document.createElement("tr");
    const values = [
      row.observation,
      formatValue(row.expected),
      formatValue(row.observed),
      row.pass ? "PASS" : "FAIL",
    ];

    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      cell.style.border = "1px solid #bbb";
      cell.style.padding = "8px";
      tableRow.appendChild(cell);
    }
    table.appendChild(tableRow);
  }

  output.replaceChildren(summary, table);

  for (const detail of details) {
    const paragraph = document.createElement("p");
    paragraph.textContent = detail;
    output.appendChild(paragraph);
  }

  console.group(title);
  console.table(
    rows.map((row) => ({
      observation: row.observation,
      expected: formatValue(row.expected),
      observed: formatValue(row.observed),
      result: row.pass ? "PASS" : "FAIL",
    })),
  );
  for (const detail of details) {
    console.log(detail);
  }
  console.log(`Scenario result: ${passed ? "PASS" : "FAIL"}`);
  console.groupEnd();

  if (!passed) {
    throw new Error(`${title} failed. Inspect the result table for details.`);
  }
}
