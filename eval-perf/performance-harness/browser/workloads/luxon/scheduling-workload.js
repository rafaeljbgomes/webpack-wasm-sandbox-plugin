import { DateTime, Duration, Interval } from "sandbox-real/luxon";

export function scheduleMeeting({
  startIso,
  zone,
  durationMinutes,
  workdayStartHour,
  workdayEndHour,
  followUpCount,
  followUpHour,
  followUpMinute,
}) {
  const meetingStart = DateTime.fromISO(startIso, { zone });
  const meetingDuration = Duration.fromObject({ minutes: durationMinutes });
  const meetingEnd = meetingStart.plus(meetingDuration);
  const workdayStart = meetingStart.startOf("day");
  const workday = Interval.fromDateTimes(
    workdayStart.plus({ hours: workdayStartHour }),
    workdayStart.plus({ hours: workdayEndHour }),
  );
  const meeting = Interval.fromDateTimes(meetingStart, meetingEnd);
  const followUps = Array.from({ length: followUpCount }, (_, index) =>
    meetingEnd
      .plus({ days: index + 1 })
      .set({ hour: followUpHour, minute: followUpMinute })
      .toFormat("yyyy-LL-dd HH:mm"),
  );

  return {
    meetingIsValid: meeting.isValid,
    workdayEngulfsMeeting: workday.engulfs(meeting),
    meetingLengthMinutes: meeting.length("minutes"),
    firstFollowUp: followUps[0],
  };
}
