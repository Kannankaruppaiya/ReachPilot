/** Identifies which connected mailbox should send, so the driver loads its tokens. */
export interface EmailSendContext {
  emailAccountId?: string;
  workspaceId?: string;
  fromEmail?: string;
}

export interface EmailDriver {
  sendEmail(
    to: string,
    subject: string,
    body: string,
    ctx?: EmailSendContext,
  ): Promise<{ status: 'sent' | 'failed'; externalId?: string; error?: string }>;
}
