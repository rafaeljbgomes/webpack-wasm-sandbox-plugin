import {
  addDays,
  differenceInBusinessDays,
  eachDayOfInterval,
  format,
  isWeekend,
  parseISO,
  startOfWeek,
} from "date-fns";

const projectStartIso = "2026-04-01T09:00:00.000Z";

export default function run() {
  const projectStart = parseISO(projectStartIso);
  const projectEnd = addDays(projectStart, 45);
  const days = eachDayOfInterval({ start: projectStart, end: projectEnd });
  const workingDays = days.filter((day) => !isWeekend(day));
  const firstWeekStart = startOfWeek(projectStart, { weekStartsOn: 1 });
  const labels = workingDays.slice(0, 10).map((day) => format(day, "yyyy-MM-dd"));
  const businessDays = differenceInBusinessDays(projectEnd, projectStart);

  if (
    workingDays.length === 0 ||
    labels[0] !== "2026-04-01" ||
    format(firstWeekStart, "yyyy-MM-dd") !== "2026-03-30" ||
    businessDays <= 0
  ) {
    throw new Error("date-fns scenario produced invalid calendar output.");
  }
}
