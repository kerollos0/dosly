/** Real-time events pushed to browsers. Rooms: `agency:<id>`. */
export type RealtimeEvent =
  | { type: 'message.new'; conversationId: string; clientId: string; messageId: string; direction: 'IN' | 'OUT' }
  | { type: 'message.updated'; conversationId: string; messageId: string }
  | { type: 'templates.updated'; waNumberId: string }
  | { type: 'message.status'; conversationId: string; messageId: string; status: string }
  | { type: 'conversation.updated'; conversationId: string; clientId: string }
  | { type: 'post.updated'; postId: string; status: string }
  | { type: 'comment.new'; commentId: string; clientId: string; fromPage: boolean }
  | { type: 'comment.updated'; commentId: string; clientId: string }
  | { type: 'ads.synced'; adAccountId: string; clientId: string }
  | { type: 'ads.alert'; clientId: string; kind: string }
  | { type: 'order.new'; orderId: string; clientId: string }
  | { type: 'order.updated'; orderId: string; clientId: string };

export interface Publisher {
  publish(agencyId: string, event: RealtimeEvent): void | Promise<void>;
}

export const nullPublisher: Publisher = { publish() {} };
