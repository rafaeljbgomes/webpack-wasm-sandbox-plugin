import { DateTime, Duration, Interval } from "luxon";

const zone = "Europe/Lisbon";
const meetingStart = DateTime.fromISO("2026-04-25T09:30:00", { zone });
const meetingDuration = Duration.fromObject({ minutes: 90 });

export default function run() {
  const meetingEnd = meetingStart.plus(meetingDuration);
  const workday = Interval.fromDateTimes(
    meetingStart.startOf("day").plus({ hours: 9 }),
    meetingStart.startOf("day").plus({ hours: 18 }),
  );
  const meeting = Interval.fromDateTimes(meetingStart, meetingEnd);
  const followUps = Array.from({ length: 8 }, (_, index) =>
    meetingEnd.plus({ days: index + 1 }).set({ hour: 10, minute: 0 }).toFormat("yyyy-LL-dd HH:mm"),
  );

  if (
    !meeting.isValid ||
    !workday.engulfs(meeting) ||
    meeting.length("minutes") !== 90 ||
    followUps[0] !== "2026-04-26 10:00"
  ) {
    throw new Error("Luxon scenario produced invalid scheduling output.");
  }
}
