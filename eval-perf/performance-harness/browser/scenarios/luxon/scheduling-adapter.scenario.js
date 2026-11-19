import { scheduleMeeting } from "sandbox-workload/luxon/scheduling";

const input = {
  startIso: "2026-04-25T09:30:00",
  zone: "Europe/Lisbon",
  durationMinutes: 90,
  workdayStartHour: 9,
  workdayEndHour: 18,
  followUpCount: 8,
  followUpHour: 10,
  followUpMinute: 0,
};

export default function run() {
  const result = scheduleMeeting(input);

  if (
    !result.meetingIsValid ||
    !result.workdayEngulfsMeeting ||
    result.meetingLengthMinutes !== 90 ||
    result.firstFollowUp !== "2026-04-26 10:00"
  ) {
    throw new Error("Luxon adapter scenario produced invalid scheduling output.");
  }
}
