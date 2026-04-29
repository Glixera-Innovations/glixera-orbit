// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import type { NextApiRequest, NextApiResponse } from "next";
import { fetchworkspace, getConfig, setConfig } from "@/utils/configEngine";
import prisma, { SessionType, document } from "@/utils/database";
import * as rbx from '@/utils/roblox'
import { logAudit } from "@/utils/logs";
import { withSessionRoute } from "@/lib/withSession";
import { withPermissionCheck } from "@/utils/permissionsManager";
import { RankGunAPI, getRankGun } from "@/utils/rankgun";

import * as noblox from "noblox.js";

type RankingResultLike = {
  success: boolean;
  error?: unknown;
  message?: unknown;
};

function rankingFailureMessage(result: RankingResultLike): string {
  let msg: unknown =
    result.error ??
    ("message" in result ? result.message : undefined) ??
    "Ranking operation failed.";
  if (typeof msg === "object") {
    try {
      msg = JSON.stringify(msg);
    } catch {
      msg = String(msg);
    }
  }
  return String(msg);
}

async function syncWorkspaceMemberRankFromRobloxNoblox(
  workspaceGroupId: number,
  userId: number
): Promise<{ rankAfter: number; rankNameAfter: string | null } | null> {
  try {
    const ocConf = await getConfig("roblox_opencloud", workspaceGroupId);
    const newRank = await rbx.getUserRank(
      BigInt(userId),
      BigInt(workspaceGroupId),
      ocConf.key
    );

    if (!newRank) {
      await prisma.rank.deleteMany({
        where: {
          userId: BigInt(userId),
          workspaceGroupId,
        },
      });

      const currentUser = await prisma.user.findFirst({
        where: { userid: BigInt(userId) },
        include: {
          roles: {
            where: { workspaceGroupId },
          },
        },
      });

      if (currentUser?.roles?.length) {
        await prisma.user.update({
          where: { userid: BigInt(userId) },
          data: {
            roles: {
              disconnect: currentUser.roles.map((r) => ({ id: r.id })),
            },
          },
        });
      }

      return {
        rankAfter: 0,
        rankNameAfter: "Guest",
      };
    }

    const rankValue = Number(newRank.rank);
    const rankNameAfter = newRank.roleName || null;

    await prisma.rank.upsert({
      where: {
        userId_workspaceGroupId: {
          userId: BigInt(userId),
          workspaceGroupId,
        },
      },
      update: {
        rankId: BigInt(rankValue),
      },
      create: {
        userId: BigInt(userId),
        workspaceGroupId,
        rankId: BigInt(rankValue),
      },
    });

    const rankInfo = await noblox.getRole(workspaceGroupId, rankValue);

    if (rankInfo) {
      const role = await prisma.role.findFirst({
        where: {
          workspaceGroupId,
          groupRoles: {
            hasSome: [BigInt(rankInfo.id)],
          },
        },
      });

      if (role) {
        const currentUser = await prisma.user.findFirst({
          where: { userid: BigInt(userId) },
          include: {
            roles: {
              where: { workspaceGroupId },
            },
          },
        });

        if (currentUser?.roles?.length) {
          await prisma.user.update({
            where: { userid: BigInt(userId) },
            data: {
              roles: {
                disconnect: currentUser.roles.map((r) => ({ id: r.id })),
              },
            },
          });
        }

        await prisma.user.update({
          where: { userid: BigInt(userId) },
          data: {
            roles: {
              connect: { id: role.id },
            },
          },
        });
      }
    }

    return {
      rankAfter: rankValue,
      rankNameAfter,
    };

  } catch (rankUpdateError) {
    console.error(
      "Error updating user rank in database:",
      rankUpdateError
    );
    return null;
  }
}

type Data = {
  success: boolean;
  error?: string;
  log?: any;
  terminated?: boolean;
};

async function checkPermissionForType(req: NextApiRequest, type: string, workspaceGroupId: number) {
  const permissionMap: Record<string, string> = {
    note: "logbook_note",
    warning: "logbook_warning",
    promotion: "logbook_promotion",
    demotion: "logbook_demotion",
    termination: "logbook_termination",
    rank_change: "logbook_promotion",
  };

  const requiredPermission = permissionMap[type];
  if (!requiredPermission) return false;

  const user = await prisma.user.findFirst({
    where: { userid: BigInt(req.session.userid) },
    include: {
      roles: { where: { workspaceGroupId } },
      workspaceMemberships: { where: { workspaceGroupId } },
    },
  });

  if (!user || !user.roles.length) return false;
  const membership = user.workspaceMemberships[0];
  const isAdmin = membership?.isAdmin || false;
  if (isAdmin) return true;

  return user.roles[0].permissions.includes(requiredPermission);
}

async function hasRankUsersPermission(req: NextApiRequest, workspaceGroupId: number): Promise<boolean> {
  const user = await prisma.user.findFirst({
    where: { userid: BigInt(req.session.userid) },
    include: {
      roles: { where: { workspaceGroupId } },
      workspaceMemberships: { where: { workspaceGroupId } },
    },
  });

  if (!user) return false;
  const membership = user.workspaceMemberships[0];
  const isAdmin = membership?.isAdmin || false;
  if (isAdmin) return true;

  return user.roles.some(role => role.permissions.includes("rank_users"));
}

async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  if (req.method !== "POST")
    return res
      .status(405)
      .json({ success: false, error: "Method not allowed" });
  const { type, notes, targetRank } = req.body;
  if (!type || !notes)
    return res
      .status(400)
      .json({ success: false, error: "Missing required fields" });

  if (
    type !== "termination" &&
    type !== "warning" &&
    type !== "promotion" &&
    type !== "demotion" &&
    type !== "note" &&
    type !== "rank_change"
  )
    return res.status(400).json({ success: false, error: "Invalid type" });
  const { uid, id } = req.query;
  if (!uid)
    return res
      .status(400)
      .json({ success: false, error: "Missing required fields" });

  const workspaceGroupId = parseInt(id as string);
  const hasPermission = await checkPermissionForType(req, type, workspaceGroupId);
  if (!hasPermission) {
    return res.status(403).json({ success: false, error: "Insufficient permissions" });
  }
  const userId = parseInt(uid as string);

  if (BigInt(userId) === req.session.userid) {
    return res.status(400).json({
      success: false,
      error: "You cannot perform actions on yourself.",
    });
  }
  const opencloudKey = await getConfig("roblox_opencloud", workspaceGroupId);
  const configOpenCloudApiKey =
    opencloudKey &&
      typeof (opencloudKey as { key?: string }).key === "string" &&
      (opencloudKey as { key: string }).key.length > 0
      ? (opencloudKey as { key: string }).key
      : null;
  const externalRanking = await prisma.workspaceExternalServices.findFirst({
    where: { workspaceGroupId },
  });
  const integratedRankingKey =
    externalRanking?.rankingProvider === "opencloudranking" &&
      typeof externalRanking?.rankingToken === "string" &&
      externalRanking.rankingToken.length > 0
      ? externalRanking.rankingToken
      : null;
  const promotionRankCap =
    typeof externalRanking?.rankingMaxRank === "number" &&
      externalRanking.rankingMaxRank >= 1
      ? externalRanking.rankingMaxRank
      : null;
  const rankingRobloxApiKey =
    integratedRankingKey ??
    ((externalRanking?.rankingProvider || "") !== "opencloudranking"
      ? configOpenCloudApiKey
      : null);
  const rankGun = await getRankGun(workspaceGroupId);
  const canUseRankGun = await hasRankUsersPermission(req, workspaceGroupId);
  let rankBefore: number | null = null;
  let rankAfter: number | null = null;
  let rankNameBefore: string | null = null;
  let rankNameAfter: string | null = null;

  if (
    (rankGun && canUseRankGun) &&
    (type === "promotion" ||
      type === "demotion" ||
      type === "rank_change" ||
      type === "termination")
  ) {
    try {
      const targetUserRank = await prisma.rank.findFirst({
        where: {
          userId: BigInt(userId),
          workspaceGroupId: workspaceGroupId,
        },
      });

      if (targetUserRank) {
        rankBefore = Number(targetUserRank.rankId);
        const currentRankInfo = await noblox.getRole(
          workspaceGroupId,
          rankBefore
        );
        rankNameBefore = currentRankInfo?.name || null;
      }

      const adminUserRank = await prisma.rank.findFirst({
        where: {
          userId: BigInt(req.session.userid),
          workspaceGroupId: workspaceGroupId,
        },
      });

      if (adminUserRank) {
        const adminRank = Number(adminUserRank.rankId);
        if (rankBefore && rankBefore >= adminRank) {
          const adminUser = await prisma.user.findFirst({
            where: {
              userid: BigInt(req.session.userid),
            },
            include: {
              workspaceMemberships: {
                where: {
                  workspaceGroupId: workspaceGroupId,
                },
              },
            },
          });

          const adminMembership = adminUser?.workspaceMemberships[0];
          const isAdmin = adminMembership?.isAdmin || false;
          if (!isAdmin) {
            return res.status(403).json({
              success: false,
              error:
                "You cannot perform ranking actions on users with equal or higher rank than yours",
            });
          }
        }
      }
    } catch (error) {
      console.error("Error getting current rank:", error);
    }
  }

  if (
    ((rankGun && canUseRankGun) || rankingRobloxApiKey) &&
    (type === "promotion" ||
      type === "demotion" ||
      type === "rank_change" ||
      type === "termination")
  ) {
    const rankGunAPI = rankGun ? new RankGunAPI(rankGun) : null;
    let result;

    try {
      switch (type) {
        case "promotion":
          if (rankGunAPI && rankGun) {
            result = await rankGunAPI.promoteUser(userId, rankGun.workspaceId);
          } else if (rankingRobloxApiKey) {
            result = await rbx.promoteUser(userId, workspaceGroupId, rankingRobloxApiKey, {
              maxPromotionRank: promotionRankCap,
            });
          } else {
            return res.status(400).json({
              success: false,
              error: "No ranking provider configured."
            });
          }
          break;
        case "demotion":
          if (rankGunAPI && rankGun) {
            result = await rankGunAPI.demoteUser(userId, rankGun.workspaceId);
          } else if (rankingRobloxApiKey) {
            result = await rbx.demoteUser(
              userId,
              workspaceGroupId,
              rankingRobloxApiKey
            );
          } else {
            return res.status(400).json({
              success: false,
              error: "No ranking provider configured."
            });
          }
          break;
        case "termination":
          if (rankGunAPI && rankGun) {
            result = await rankGunAPI.terminateUser(userId, rankGun.workspaceId);
          } else if (rankingRobloxApiKey) {
            result = await rbx.terminateUser(
              userId,
              workspaceGroupId,
              rankingRobloxApiKey
            );
          } else {
            return res.status(400).json({
              success: false,
              error: "No ranking provider configured."
            });
          }
          break;
        case "rank_change":
          if (!targetRank || isNaN(targetRank)) {
            return res.status(400).json({
              success: false,
              error: "Target rank is required for rank change.",
            });
          }
          try {
            const adminUserRank = await prisma.rank.findFirst({
              where: {
                userId: BigInt(req.session.userid),
                workspaceGroupId: workspaceGroupId,
              },
            });

            if (adminUserRank) {
              const adminRank = Number(adminUserRank.rankId);

              if (parseInt(targetRank) >= adminRank) {
                const adminUser = await prisma.user.findFirst({
                  where: {
                    userid: BigInt(req.session.userid),
                  },
                  include: {
                    workspaceMemberships: {
                      where: {
                        workspaceGroupId: workspaceGroupId,
                      },
                    },
                  },
                });

                const adminMembership = adminUser?.workspaceMemberships[0];
                const isAdmin = adminMembership?.isAdmin || false;
                if (!isAdmin) {
                  return res.status(403).json({
                    success: false,
                    error:
                      "You cannot set users to a rank equal to or higher than your own.",
                  });
                }
              }
            }
          } catch (rankCheckError) {
            console.error(
              "Error checking admin rank for rank_change:",
              rankCheckError
            );
          }

          if (rankGunAPI) {
            result = await rankGunAPI.setUserRank(
              userId,
              rankGun ? rankGun.workspaceId : "",
              parseInt(targetRank)
            );
          } else if (rankingRobloxApiKey) {
            result = await rbx.rankChange(
              userId,
              workspaceGroupId,
              parseInt(String(targetRank), 10),
              rankingRobloxApiKey,
              { maxPromotionRank: promotionRankCap }
            );
          } else {
            return res.status(400).json({
              success: false,
              error: "No ranking provider configured."
            });
            break;
          }

          if (result && !result.success) {
            console.error("RankGun returned an error result:", result);
            let errorMessage =
              result.error ||
              (result as { message?: string }).message ||
              "Ranking operation failed.";
            if (typeof errorMessage === "object") {
              try {
                errorMessage = JSON.stringify(errorMessage);
              } catch (e) {
                errorMessage = String(errorMessage);
              }
            }
            return res.status(400).json({
              success: false,
              error: String(errorMessage),
            });
          }

          const syncedRank = await syncWorkspaceMemberRankFromRobloxNoblox(
            workspaceGroupId,
            userId
          );
          if (syncedRank) {
            rankAfter = syncedRank.rankAfter;
            rankNameAfter = syncedRank.rankNameAfter;
          }
      }

      if (
        typeof result !== "undefined" &&
        result &&
        typeof result === "object" &&
        "success" in result &&
        (type === "promotion" ||
          type === "demotion" ||
          type === "termination")
      ) {
        const r = result as RankingResultLike;
        if (!r.success) {
          return res.status(400).json({
            success: false,
            error: rankingFailureMessage(r),
          });
        }
      }

      if (
        typeof result !== "undefined" &&
        result &&
        typeof result === "object" &&
        "success" in result &&
        (result as RankingResultLike).success &&
        (type === "promotion" || type === "demotion")
      ) {
        const synced = await syncWorkspaceMemberRankFromRobloxNoblox(
          workspaceGroupId,
          userId
        );
        if (synced) {
          rankAfter = synced.rankAfter;
          rankNameAfter = synced.rankNameAfter;
        }
      }

    } catch (error: any) {
      let errorMessage =
        error?.response?.data?.error ||
        error?.message ||
        "RankGun operation failed";
      if (typeof errorMessage === "object") {
        try {
          errorMessage = JSON.stringify(errorMessage);
        } catch (e) {
          errorMessage = String(errorMessage);
        }
      }
      return res.status(500).json({
        success: false,
        error: String(errorMessage),
      });
    }
  }

  const userbook = await prisma.userBook.create({
    data: {
      userId: BigInt(uid as string),
      type,
      workspaceGroupId: parseInt(id as string),
      reason: notes,
      adminId: BigInt(req.session.userid),
      rankBefore,
      rankAfter,
      rankNameBefore,
      rankNameAfter,
    },
    include: {
      admin: true,
    },
  });

  try {
    await logAudit(
      parseInt(id as string),
      req.session.userid || null,
      "userbook.create",
      `userbook:${userbook.id}`,
      {
        type,
        userId: uid,
        adminId: req.session.userid,
        rankBefore,
        rankAfter,
        rankNameBefore,
        rankNameAfter,
      }
    );
  } catch (e) { }

  res.status(200).json({
    success: true,
    log: JSON.parse(
      JSON.stringify(userbook, (key, value) =>
        typeof value === "bigint" ? value.toString() : value
      )
    ),
  });
}

export default withSessionRoute(handler);
