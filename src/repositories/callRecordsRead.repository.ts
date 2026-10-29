import { CallStatus, type Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

const callListSelect = {
  id: true,
  leadId: true,
  personKey: true,
  retellCallId: true,
  status: true,
  outcome: true,
  summary: true,
  startedAt: true,
  endedAt: true,
  direction: true,
  customerTz: true,
  disconnectionReason: true,
  recordingUrl: true,
  noteStatus: true,
  noteAttempts: true,
  noteLastAttemptAt: true,
  noteDeliveredAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CallRecordSelect;

const callDetailSelect = {
  ...callListSelect,
  transcript: true,
  transcriptJson: true,
  analysis: true,
} satisfies Prisma.CallRecordSelect;

export type CallListRecord = Prisma.CallRecordGetPayload<{ select: typeof callListSelect }>;
export type CallDetailRecord = Prisma.CallRecordGetPayload<{ select: typeof callDetailSelect }>;

export interface ListCallRecordsInput {
  limit: number;
  cursor?: string;
  leadId?: string;
  status?: CallStatus;
}

export async function listCallRecords(input: ListCallRecordsInput): Promise<{
  records: CallListRecord[];
  nextCursor: string | null;
}> {
  const rows = await prisma.callRecord.findMany({
    where: {
      ...(input.leadId ? { leadId: input.leadId } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
    select: callListSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > input.limit;
  const records = hasMore ? rows.slice(0, input.limit) : rows;
  return {
    records,
    nextCursor: hasMore ? records[records.length - 1]?.id ?? null : null,
  };
}

export async function getCallRecordByIdOrRetellCallId(
  idOrRetellCallId: string,
): Promise<CallDetailRecord | null> {
  return prisma.callRecord.findFirst({
    where: {
      OR: [{ id: idOrRetellCallId }, { retellCallId: idOrRetellCallId }],
    },
    select: callDetailSelect,
  });
}
