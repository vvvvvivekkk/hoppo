'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatMessageEvent } from '@hoppo/api-client';
import { Shell } from '@/components/shell';
import { Banner, Button, Spinner } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { useSocket } from '@/lib/socket';

/**
 * S-19 / S-28 / S-30: in-app chat between a student and their rider on an
 * active order. Text only for Phase 1.
 *
 * Messages are loaded from REST (newest-first, reversed for display) and
 * new ones arrive over the socket. Each outgoing message carries a client
 * id for deduplication — the server skips a duplicate insert, and the UI
 * deduplicates on arrival.
 */
export default function ChatPage() {
  const params = useParams<{ orderId: string }>();
  const orderId = params.orderId;
  const { api, client, signedIn } = useApi();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const seenIds = useRef(new Set<string>());

  // Load history on mount.
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await api.chat.orderMessages(orderId, {});
        if (cancelled) return;
        const reversed = [...res.messages].reverse();
        reversed.forEach((m) => seenIds.current.add(m.id));
        setMessages(reversed);
      } catch (e) {
        if (!cancelled) setError(describeError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [api, orderId, signedIn]);

  // Live incoming messages via the socket.
  useSocket(client, signedIn, {
    onChatMessage: useCallback((payload: Record<string, unknown>) => {
      const event = payload as unknown as ChatMessageEvent;
      if (event.orderId !== orderId) return;
      if (seenIds.current.has(event.id)) return;
      seenIds.current.add(event.id);
      const msg: ChatMessage = {
        id: event.id,
        senderId: event.senderId,
        senderRole: event.senderRole,
        body: event.body,
        deleted: false,
        clientMessageId: event.clientMessageId,
        sentAt: event.sentAt,
      };
      setMessages((prev) => [...prev, msg]);
    }, [orderId]),
  });

  // Auto-scroll on new messages.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  async function send() {
    const body = text.trim();
    if (!body) return;

    setSending(true);
    setSendError(null);
    const clientMessageId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Optimistic append.
    const optimistic: ChatMessage = {
      id: `pending-${clientMessageId}`,
      senderId: 'me',
      senderRole: 'REQUESTER',
      body,
      deleted: false,
      clientMessageId,
      sentAt: new Date().toISOString(),
    };
    seenIds.current.add(optimistic.id);
    setMessages((prev) => [...prev, optimistic]);
    setText('');

    try {
      const res = await api.chat.sendToOrder(orderId, body, clientMessageId);
      // Replace the optimistic message with the real one.
      seenIds.current.add(res.message.id);
      setMessages((prev) =>
        prev.map((m) => (m.id === optimistic.id ? res.message : m)),
      );
    } catch (e) {
      setSendError(describeError(e));
      // Remove the optimistic message on failure.
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setText(body); // restore the text so they can retry
    } finally {
      setSending(false);
    }
  }

  if (!signedIn || loading) {
    return (
      <Shell back={`/orders/${orderId}`} title="Chat">
        <Spinner />
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell back={`/orders/${orderId}`} title="Chat">
        <Banner tone="error">{error}</Banner>
      </Shell>
    );
  }

  return (
    <Shell back={`/orders/${orderId}`} title="Chat with your rider">
      <div className="flex flex-1 flex-col">
        {/* Messages */}
        <div className="flex-1 space-y-2 overflow-y-auto pb-4">
          {messages.length === 0 && (
            <p className="py-8 text-center text-sm text-[var(--color-ink-faint)]">
              No messages yet. Say hi to your rider!
            </p>
          )}
          {messages.map((m) => {
            const mine = m.senderRole === 'REQUESTER';
            if (m.deleted) {
              return (
                <div key={m.id} className="text-center text-xs text-[var(--color-ink-faint)]">
                  This message was removed.
                </div>
              );
            }
            return (
              <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
                    mine
                      ? 'bg-[var(--color-accent)] text-white'
                      : 'bg-[var(--color-surface-raised)] text-[var(--color-ink)]'
                  } ${m.id.startsWith('pending-') ? 'opacity-60' : ''}`}
                >
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  <p
                    className={`mt-0.5 text-[10px] ${
                      mine ? 'text-white/70' : 'text-[var(--color-ink-faint)]'
                    }`}
                  >
                    {new Date(m.sentAt).toLocaleTimeString('en-IN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Send bar */}
        {sendError && (
          <div className="mb-2">
            <Banner tone="error">{sendError}</Banner>
          </div>
        )}
        <form
          className="flex gap-2 border-t border-[var(--color-line)] pt-3 pb-safe"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            type="text"
            className="min-w-0 flex-1 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            placeholder="Type a message…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={2000}
            disabled={sending}
          />
          <Button
            type="submit"
            disabled={!text.trim() || sending}
            className="shrink-0 rounded-full px-4"
          >
            Send
          </Button>
        </form>
      </div>
    </Shell>
  );
}
