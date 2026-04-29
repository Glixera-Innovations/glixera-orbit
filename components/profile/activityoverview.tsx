import React, { useState, useEffect, useMemo } from "react";
import { ActivitySessionDetailsDialog } from "@/components/activity/ActivitySessionDetailsDialog";
import { useRouter } from "next/router";
import axios from "axios";
import toast from "react-hot-toast";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip as ChartTooltip,
  Legend,
  ChartData,
  ScatterDataPoint,
} from "chart.js";
import {
  IconChartBar,
  IconPlayerPlay,
  IconUsers,
  IconCalendarTime,
  IconClipboardList,
  IconClock,
} from "@tabler/icons-react";
import { useRecoilValue } from "recoil";
import { themeState } from "@/state/theme";
import moment from "moment";
import type { ActivitySession, inactivityNotice } from "@prisma/client";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  ChartTooltip,
  Legend
);

type TimelineItem =
  | ({ __type: "session" } & ActivitySession & {
      user: { picture: string | null };
    })
  | ({ __type: "notice" } & inactivityNotice)
  | ({ __type: "adjustment" } & any);

type Props = {
  data: any;
  displayMinutes: number;
  messages: number;
  idleTime: number;
  sessionsHosted: number;
  sessionsAttended: number;
  idleTimeEnabled: boolean;
  notices: inactivityNotice[];
  adjustments: any[];
  sessions: (ActivitySession & {
    user: {
      picture: string | null;
    };
  })[];
  avatar: string;
};

export function ActivityOverview({
  data,
  displayMinutes,
  messages,
  idleTime,
  sessionsHosted,
  sessionsAttended,
  idleTimeEnabled,
  adjustments,
  sessions,
  avatar,
}: Props) {
  const router = useRouter();
  const { id } = router.query;
  
  const [chartData, setChartData] = useState<
    ChartData<"line", (number | ScatterDataPoint | null)[], unknown>
  >({
    datasets: [],
  });
  const [chartOptions, setChartOptions] = useState({});
  const [timeline, setTimeline] = useState<TimelineItem[]>(() => {
    const adj = adjustments.map((a) => ({ ...a, __type: "adjustment" }));
    return [
      ...sessions.map((s) => ({ ...s, __type: "session" })),
      ...adj,
    ];
  });
  const [isOpen, setIsOpen] = useState(false);
  const [dialogData, setDialogData] = useState<any>({});
  const [concurrentUsers, setConcurrentUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [liveSessionTimer, setLiveSessionTimer] = useState<NodeJS.Timeout | null>(null);

  const theme = useRecoilValue(themeState);
  const isDark = theme === "dark";

  const sortedTimeline = useMemo(() => {
    return [...timeline].sort((a, b) => {
      const aDate =
        a.__type === "adjustment"
          ? new Date((a as any).createdAt).getTime()
          : new Date((a as any).startTime || (a as any).createdAt).getTime();
      const bDate =
        b.__type === "adjustment"
          ? new Date((b as any).createdAt).getTime()
          : new Date((b as any).startTime || (b as any).createdAt).getTime();
      return bDate - aDate;
    });
  }, [timeline]);

  useEffect(() => {
    const hasLiveSessions = timeline.some(
      (item) => item.__type === "session" && item.active && !item.endTime
    );

    if (hasLiveSessions) {
      const timer = setInterval(() => {
        setTimeline((prev) => [...prev]);
      }, 60000);

      setLiveSessionTimer(timer);

      return () => {
        clearInterval(timer);
        setLiveSessionTimer(null);
      };
    } else if (liveSessionTimer) {
      clearInterval(liveSessionTimer);
      setLiveSessionTimer(null);
    }
  }, [timeline, liveSessionTimer]);

  useEffect(() => {
    return () => {
      if (liveSessionTimer) {
        clearInterval(liveSessionTimer);
      }
    };
  }, [liveSessionTimer]);

  const fetchSession = async (sessionId: string) => {
    setLoading(true);
    setIsOpen(true);
    setConcurrentUsers([]);

    try {
      const { data, status } = await axios.get(
        `/api/workspace/${id}/activity/${sessionId}`
      );
      if (status !== 200) return toast.error("Could not fetch session.");
      if (!data.universe) {
        setLoading(false);
        return setDialogData({
          type: "session",
          data: data.message,
          universe: null,
        });
      }

      setDialogData({
        type: "session",
        data: data.message,
        universe: data.universe,
      });

      if (data.message?.startTime && data.message?.endTime) {
        try {
          const concurrentResponse = await axios.get(
            `/api/workspace/${id}/activity/concurrent?sessionId=${sessionId}&startTime=${data.message.startTime}&endTime=${data.message.endTime}`
          );

          if (concurrentResponse.status === 200) {
            setConcurrentUsers(concurrentResponse.data.users || []);
          }
        } catch (error) {
          console.error("Failed to fetch concurrent users:", error);
        }
      }

      setLoading(false);
    } catch (error) {
      return toast.error("Could not fetch session.");
    }
  };

  useEffect(() => {
    setChartData({
      labels: [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ],
      datasets: [
        {
          label: "Activity in minutes",
          data,
          borderColor: "rgb(var(--group-theme))",
          backgroundColor: "rgb(var(--group-theme))",
          tension: 0.25,
        },
      ],
    });
    setChartOptions({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "top",
          labels: { color: isDark ? "#fff" : "#222" },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: {
            color: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.05)",
          },
          ticks: { color: isDark ? "#fff" : "#222" },
        },
        x: {
          grid: {
            color: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.05)",
          },
          ticks: { color: isDark ? "#fff" : "#222" },
        },
      },
    });
  }, [data, isDark]);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="relative overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-700/60 bg-white dark:bg-zinc-800/80 p-5 backdrop-blur-sm">
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary/70 rounded-t-xl" />
          <div className="flex items-center gap-2.5 mb-4">
            <div className="p-1.5 bg-primary/10 rounded-md">
              <IconPlayerPlay className="w-4 h-4 text-primary" />
            </div>
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
              Activity
            </p>
          </div>
          <div>
            <div className="text-3xl font-bold text-zinc-900 dark:text-white tabular-nums">
              {displayMinutes}
            </div>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">
              minutes of activity
            </p>
          </div>
        </div>

        <div className="relative overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-700/60 bg-white dark:bg-zinc-800/80 p-5 backdrop-blur-sm">
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary/70 rounded-t-xl" />
          <div className="flex items-center gap-2.5 mb-4">
            <div className="p-1.5 bg-primary/10 rounded-md">
              <IconUsers className="w-4 h-4 text-primary" />
            </div>
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
              Messages
            </p>
          </div>
          <div>
            <div className="text-3xl font-bold text-zinc-900 dark:text-white tabular-nums">
              {messages}
            </div>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">
              messages this period
            </p>
          </div>
        </div>

        {idleTimeEnabled && (
          <div className="relative overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-700/60 bg-white dark:bg-zinc-800/80 p-5 backdrop-blur-sm">
            <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary/70 rounded-t-xl" />
            <div className="flex items-center gap-2.5 mb-4">
              <div className="p-1.5 bg-primary/10 rounded-md">
                <IconClock className="w-4 h-4 text-primary" />
              </div>
              <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                Idle Time
              </p>
            </div>
            <div>
              <div className="text-3xl font-bold text-zinc-900 dark:text-white tabular-nums">
                {idleTime}
              </div>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">
                minutes idle
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-700/60 bg-white dark:bg-zinc-800/80 overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-zinc-100 dark:border-zinc-700/60">
          <div className="p-1.5 bg-primary/10 rounded-md">
            <IconCalendarTime className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">
              Activity Timeline
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Sessions and manual adjustments
            </p>
          </div>
        </div>
        <div className="p-5">
          {sortedTimeline.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <div className="w-12 h-12 bg-zinc-100 dark:bg-zinc-700/50 rounded-full flex items-center justify-center">
                <IconClipboardList className="w-6 h-6 text-zinc-400 dark:text-zinc-500" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">No activity yet</p>
                <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
                  Sessions and adjustments will appear here
                </p>
              </div>
            </div>
          ) : (
            <ol className="relative border-l border-zinc-200 dark:border-zinc-700 ml-3 space-y-1">
              {sortedTimeline.map((item: TimelineItem) => {
                if (item.__type === "session") {
                  const isLive = item.active && !item.endTime;
                  const sessionDuration = isLive
                    ? Math.floor(
                        (new Date().getTime() -
                          new Date(item.startTime).getTime()) /
                          (1000 * 60)
                      )
                    : Math.floor(
                        (new Date(item.endTime || new Date()).getTime() -
                          new Date(item.startTime).getTime()) /
                          (1000 * 60)
                      );

                  return (
                    <li key={`session-${item.id}`} className="mb-5 ml-5">
                      <span
                        className={`flex absolute -left-3 justify-center items-center w-6 h-6 ${
                          isLive
                            ? "bg-green-500 animate-pulse"
                            : "bg-primary"
                        } rounded-full ring-4 ring-white dark:ring-zinc-800`}
                      >
                        {isLive ? (
                          <div className="w-2.5 h-2.5 bg-white rounded-full" />
                        ) : (
                          <img
                            className="rounded-full w-full h-full object-cover"
                            src={item.user.picture ? item.user.picture : avatar}
                            alt="timeline avatar"
                          />
                        )}
                      </span>
                      <div
                        onClick={() => !isLive && fetchSession(item.id)}
                        className={`rounded-lg border transition-all duration-150 ${
                          isLive
                            ? "bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800/50"
                            : "bg-zinc-50 dark:bg-zinc-700/40 border-zinc-200 dark:border-zinc-700/60 cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-700/70 hover:border-zinc-300 dark:hover:border-zinc-600"
                        } px-4 py-3`}
                      >
                        <div className="flex justify-between items-start gap-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <p className="text-sm font-medium text-zinc-900 dark:text-white truncate">
                              Activity Session
                            </p>
                            {isLive && (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300 shrink-0">
                                LIVE
                              </span>
                            )}
                          </div>
                          <time className="text-xs text-zinc-400 dark:text-zinc-500 shrink-0 tabular-nums">
                            {isLive ? (
                              <>Started {moment(item.startTime).format("HH:mm")} · {sessionDuration}m</>
                            ) : (
                              <>{moment(item.startTime).format("HH:mm")}–{moment(item.endTime).format("HH:mm")} · {moment(item.startTime).format("D MMM")} · {sessionDuration}m</>
                            )}
                          </time>
                        </div>
                        {isLive && (
                          <p className="text-xs text-green-600 dark:text-green-400 mt-1">
                            Currently active in game
                          </p>
                        )}
                      </div>
                    </li>
                  );
                }
                if (item.__type === "adjustment") {
                  const positive = item.minutes > 0;
                  return (
                    <li key={`adjust-${item.id}`} className="mb-5 ml-5">
                      <span
                        className={`flex absolute -left-3 justify-center items-center w-6 h-6 ${
                          positive ? "bg-emerald-500" : "bg-red-500"
                        } rounded-full ring-4 ring-white dark:ring-zinc-800 text-white text-xs font-bold`}
                      >
                        {positive ? "+" : "−"}
                      </span>
                      <div className="rounded-lg border border-zinc-200 dark:border-zinc-700/60 bg-zinc-50 dark:bg-zinc-700/40 px-4 py-3">
                        <div className="flex justify-between items-start gap-3">
                          <p className="text-sm font-medium text-zinc-900 dark:text-white">
                            Manual Adjustment
                          </p>
                          <time className="text-xs text-zinc-400 dark:text-zinc-500 shrink-0 tabular-nums">
                            {moment(item.createdAt).format("D MMM YYYY, HH:mm")}
                          </time>
                        </div>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                          <span className={positive ? "text-emerald-600 dark:text-emerald-400 font-medium" : "text-red-600 dark:text-red-400 font-medium"}>
                            {positive ? "+" : "−"}{Math.abs(item.minutes)} min
                          </span>
                          {" "}by {item.actor?.username || "Unknown"}
                          {item.reason && <span className="text-zinc-400 dark:text-zinc-500"> · {item.reason}</span>}
                        </p>
                      </div>
                    </li>
                  );
                }
              })}
            </ol>
          )}
        </div>
      </div>

      <ActivitySessionDetailsDialog
        open={isOpen}
        loading={loading}
        onClose={() => setIsOpen(false)}
        session={dialogData?.data ?? null}
        universe={dialogData?.universe}
        concurrentUsers={concurrentUsers}
        idleTimeEnabled={idleTimeEnabled}
      />
    </div>
  );
}
