/** Real-time events pushed to browsers. Rooms: `agency:<id>`. */
export type RealtimeEvent =
  | { type: 'message.new'; conversationId: string; clientId: string; messageId: string }
  | { type: 'message.status'; conversationId: string; messageId: string; status: string }
  | { type: 'conversation.updated'; conversationId: string; clientId: string }
  | { type: 'post.updated'; postId: string; status: string };

export interface Publisher {
  publish(agencyId: string, event: RealtimeEvent): void | Promise<void>;
}

export const nullPublisher: Publisher = { publish() {} };
