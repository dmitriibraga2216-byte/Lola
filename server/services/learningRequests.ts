import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import {
  courses, enrollments, locations, positions, programEnrollments, programs,
  trajectories, trajectoryEnrollments, userPlacements, users,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'

interface Ctx { tenantId: string, actorId: string }

export interface LearningRequestRow {
  id: string
  kind: 'course' | 'program' | 'trajectory'
  title: string
  userId: string
  fullName: string
  positionName: string | null
  locationName: string | null
  requestedAt: string
  status: 'pending' | 'approved' | 'rejected'
  decisionReason: string | null
}

/**
 * Приймання заявок на навчання (docs/10 §14.1, мокап LearningRequests): дві вкладки —
 * «Завдання» (заявки на курси через каталог) і «Траєкторії навчання» (програми й траєкторії —
 * для Lola це одна сутність з двома режимами відображення, docs/17 §1). Заявка — запис
 * зі status not_assigned і заповненим requestedAt; рішення — cancelledAt (відмова) або
 * перехід статусу далі not_assigned (схвалено).
 */
export async function listLearningRequests(ctx: Ctx, kind: 'tasks' | 'trajectories'): Promise<LearningRequestRow[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const placement = and(eq(userPlacements.userId, users.id), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt))

    if (kind === 'tasks') {
      const rows = await tx.select({
        id: enrollments.id,
        title: courses.title,
        userId: enrollments.userId,
        fullName: users.fullName,
        positionName: positions.name,
        locationName: locations.name,
        requestedAt: enrollments.requestedAt,
        status: enrollments.status,
        cancelledAt: enrollments.cancelledAt,
        decisionReason: enrollments.cancelReason,
      })
        .from(enrollments)
        .innerJoin(courses, eq(courses.id, enrollments.subjectId))
        .innerJoin(users, eq(users.id, enrollments.userId))
        .leftJoin(userPlacements, placement)
        .leftJoin(positions, eq(positions.id, userPlacements.positionId))
        .leftJoin(locations, eq(locations.id, userPlacements.locationId))
        .where(and(eq(enrollments.tenantId, ctx.tenantId), isNotNull(enrollments.requestedAt)))
        .orderBy(desc(enrollments.requestedAt))
        .limit(300)
      return rows.map(r => ({ ...toRow(r), kind: 'course' as const }))
    }

    const progRows = await tx.select({
      id: programEnrollments.id,
      title: programs.title,
      userId: programEnrollments.userId,
      fullName: users.fullName,
      positionName: positions.name,
      locationName: locations.name,
      requestedAt: programEnrollments.requestedAt,
      status: programEnrollments.status,
      cancelledAt: programEnrollments.cancelledAt,
      decisionReason: programEnrollments.cancelReason,
    })
      .from(programEnrollments)
      .innerJoin(programs, eq(programs.id, programEnrollments.programId))
      .innerJoin(users, eq(users.id, programEnrollments.userId))
      .leftJoin(userPlacements, placement)
      .leftJoin(positions, eq(positions.id, userPlacements.positionId))
      .leftJoin(locations, eq(locations.id, userPlacements.locationId))
      .where(and(eq(programEnrollments.tenantId, ctx.tenantId), isNotNull(programEnrollments.requestedAt)))
      .orderBy(desc(programEnrollments.requestedAt))
      .limit(300)

    const trajRows = await tx.select({
      id: trajectoryEnrollments.id,
      title: trajectories.title,
      userId: trajectoryEnrollments.userId,
      fullName: users.fullName,
      positionName: positions.name,
      locationName: locations.name,
      requestedAt: trajectoryEnrollments.requestedAt,
      status: trajectoryEnrollments.status,
      cancelledAt: trajectoryEnrollments.cancelledAt,
      decisionReason: trajectoryEnrollments.cancelReason,
    })
      .from(trajectoryEnrollments)
      .innerJoin(trajectories, eq(trajectories.id, trajectoryEnrollments.trajectoryId))
      .innerJoin(users, eq(users.id, trajectoryEnrollments.userId))
      .leftJoin(userPlacements, placement)
      .leftJoin(positions, eq(positions.id, userPlacements.positionId))
      .leftJoin(locations, eq(locations.id, userPlacements.locationId))
      .where(and(eq(trajectoryEnrollments.tenantId, ctx.tenantId), isNotNull(trajectoryEnrollments.requestedAt)))
      .orderBy(desc(trajectoryEnrollments.requestedAt))
      .limit(300)

    return [
      ...progRows.map(r => ({ ...toRow(r), kind: 'program' as const })),
      ...trajRows.map(r => ({ ...toRow(r), kind: 'trajectory' as const })),
    ].sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt))
  })
}

function toRow(r: {
  id: string
  title: string
  userId: string
  fullName: string
  positionName: string | null
  locationName: string | null
  requestedAt: Date | null
  status: string
  cancelledAt: Date | null
  decisionReason: string | null
}): Omit<LearningRequestRow, 'kind'> {
  const status: LearningRequestRow['status'] = r.cancelledAt ? 'rejected' : r.status === 'not_assigned' ? 'pending' : 'approved'
  return {
    id: r.id,
    title: r.title,
    userId: r.userId,
    fullName: r.fullName,
    positionName: r.positionName,
    locationName: r.locationName,
    requestedAt: r.requestedAt!.toISOString(),
    status,
    decisionReason: r.decisionReason,
  }
}
