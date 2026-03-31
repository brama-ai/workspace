<?php

declare(strict_types=1);

namespace App\Telegram;

/**
 * Normalizes raw Telegram Update payloads into platform NormalizedEvent arrays.
 * Moved from brama-core App\Telegram\Service\TelegramUpdateNormalizer.
 * Returns plain arrays (not DTOs) since this is an A2A agent boundary.
 */
final class TelegramNormalizer
{
    /**
     * Normalize a raw Telegram Update into one or more NormalizedEvent arrays.
     *
     * @param array<string, mixed> $update
     *
     * @return list<array<string, mixed>>
     */
    public function normalize(array $update, string $channelId): array
    {
        $updateId = (int) ($update['update_id'] ?? 0);
        $traceId = 'tg_'.bin2hex(random_bytes(8));
        $requestId = 'req_'.bin2hex(random_bytes(8));

        if (isset($update['callback_query'])) {
            return [$this->normalizeCallbackQuery($update['callback_query'], $channelId, $updateId, $traceId, $requestId)];
        }

        if (isset($update['channel_post'])) {
            return [$this->normalizeMessage($update['channel_post'], $channelId, $updateId, $traceId, $requestId, 'channel_post_created')];
        }

        if (isset($update['edited_channel_post'])) {
            return [$this->normalizeMessage($update['edited_channel_post'], $channelId, $updateId, $traceId, $requestId, 'channel_post_edited')];
        }

        if (isset($update['edited_message'])) {
            return [$this->normalizeMessage($update['edited_message'], $channelId, $updateId, $traceId, $requestId, 'message_edited')];
        }

        if (isset($update['message'])) {
            return $this->normalizeMessageUpdate($update['message'], $channelId, $updateId, $traceId, $requestId);
        }

        return [];
    }

    /**
     * @param array<string, mixed> $message
     *
     * @return list<array<string, mixed>>
     */
    private function normalizeMessageUpdate(array $message, string $channelId, int $updateId, string $traceId, string $requestId): array
    {
        // Member joined
        if (isset($message['new_chat_members'])) {
            $events = [];
            foreach ($message['new_chat_members'] as $member) {
                $events[] = $this->buildEvent(
                    'member_joined',
                    $channelId,
                    $this->extractChat($message),
                    $this->buildSender($member),
                    $this->buildMessage($message),
                    $updateId,
                    $traceId,
                    $requestId,
                );
            }

            return $events;
        }

        // Member left
        if (isset($message['left_chat_member'])) {
            return [$this->buildEvent(
                'member_left',
                $channelId,
                $this->extractChat($message),
                $this->buildSender($message['left_chat_member']),
                $this->buildMessage($message),
                $updateId,
                $traceId,
                $requestId,
            )];
        }

        // Bot command
        if ($this->hasCommandEntity($message)) {
            return [$this->normalizeCommand($message, $channelId, $updateId, $traceId, $requestId)];
        }

        // Regular message
        return [$this->normalizeMessage($message, $channelId, $updateId, $traceId, $requestId, 'message_created')];
    }

    /**
     * @param array<string, mixed> $message
     *
     * @return array<string, mixed>
     */
    private function normalizeMessage(array $message, string $channelId, int $updateId, string $traceId, string $requestId, string $eventType): array
    {
        return $this->buildEvent(
            $eventType,
            $channelId,
            $this->extractChat($message),
            $this->extractSender($message),
            $this->buildMessage($message),
            $updateId,
            $traceId,
            $requestId,
        );
    }

    /**
     * @param array<string, mixed> $message
     *
     * @return array<string, mixed>
     */
    private function normalizeCommand(array $message, string $channelId, int $updateId, string $traceId, string $requestId): array
    {
        $text = (string) ($message['text'] ?? '');
        $commandName = null;
        $commandArgs = null;

        foreach (($message['entities'] ?? []) as $entity) {
            if (($entity['type'] ?? '') === 'bot_command' && ($entity['offset'] ?? -1) === 0) {
                $commandFull = substr($text, (int) $entity['offset'], (int) $entity['length']);
                // Remove @botname suffix if present
                $commandName = explode('@', $commandFull)[0];
                $commandArgs = trim(substr($text, (int) $entity['length'])) ?: null;
                break;
            }
        }

        $msg = [
            'id' => (string) ($message['message_id'] ?? '0'),
            'text' => $text,
            'reply_to_message_id' => isset($message['reply_to_message']) ? (string) $message['reply_to_message']['message_id'] : null,
            'has_media' => false,
            'media_type' => null,
            'forward_from' => null,
            'timestamp' => isset($message['date']) ? date('c', (int) $message['date']) : null,
            'command_name' => $commandName,
            'command_args' => $commandArgs,
            'callback_data' => null,
            'callback_query_id' => null,
        ];

        return $this->buildEvent(
            'command_received',
            $channelId,
            $this->extractChat($message),
            $this->extractSender($message),
            $msg,
            $updateId,
            $traceId,
            $requestId,
        );
    }

    /**
     * @param array<string, mixed> $callbackQuery
     *
     * @return array<string, mixed>
     */
    private function normalizeCallbackQuery(array $callbackQuery, string $channelId, int $updateId, string $traceId, string $requestId): array
    {
        $cbMessage = $callbackQuery['message'] ?? [];
        $chat = isset($cbMessage['chat']) ? $this->extractChat($cbMessage) : ['id' => '0', 'type' => 'unknown', 'title' => null, 'thread_id' => null];

        $msg = [
            'id' => (string) ($cbMessage['message_id'] ?? '0'),
            'text' => $callbackQuery['data'] ?? null,
            'reply_to_message_id' => null,
            'has_media' => false,
            'media_type' => null,
            'forward_from' => null,
            'timestamp' => null,
            'command_name' => null,
            'command_args' => null,
            'callback_data' => $callbackQuery['data'] ?? null,
            'callback_query_id' => (string) ($callbackQuery['id'] ?? ''),
        ];

        $from = $callbackQuery['from'] ?? [];

        return $this->buildEvent(
            'callback_query',
            $channelId,
            $chat,
            $this->buildSender($from),
            $msg,
            $updateId,
            $traceId,
            $requestId,
        );
    }

    /**
     * @param array<string, mixed> $message
     *
     * @return array<string, mixed>
     */
    private function extractChat(array $message): array
    {
        $chat = $message['chat'] ?? [];

        $threadId = null;
        if (isset($message['message_thread_id']) && ($message['is_topic_message'] ?? false)) {
            $threadId = (string) $message['message_thread_id'];
        }

        return [
            'id' => (string) ($chat['id'] ?? '0'),
            'type' => (string) ($chat['type'] ?? 'unknown'),
            'title' => $chat['title'] ?? null,
            'thread_id' => $threadId,
        ];
    }

    /**
     * @param array<string, mixed> $message
     *
     * @return array<string, mixed>
     */
    private function extractSender(array $message): array
    {
        $from = $message['from'] ?? $message['sender_chat'] ?? [];

        return $this->buildSender($from);
    }

    /**
     * @param array<string, mixed> $from
     *
     * @return array<string, mixed>
     */
    private function buildSender(array $from): array
    {
        return [
            'id' => (string) ($from['id'] ?? '0'),
            'username' => $from['username'] ?? null,
            'first_name' => $from['first_name'] ?? $from['title'] ?? null,
            'role' => 'user',
            'is_bot' => (bool) ($from['is_bot'] ?? false),
        ];
    }

    /**
     * @param array<string, mixed> $message
     *
     * @return array<string, mixed>
     */
    private function buildMessage(array $message): array
    {
        $text = $message['text'] ?? $message['caption'] ?? null;
        $hasMedia = false;
        $mediaType = null;

        $mediaTypes = ['photo', 'document', 'video', 'voice', 'audio', 'sticker', 'animation', 'video_note'];
        foreach ($mediaTypes as $type) {
            if (isset($message[$type])) {
                $hasMedia = true;
                $mediaType = $type;
                break;
            }
        }

        $forwardFrom = null;
        if (isset($message['forward_from'])) {
            $forwardFrom = $message['forward_from']['username'] ?? $message['forward_from']['first_name'] ?? 'unknown';
        } elseif (isset($message['forward_from_chat'])) {
            $forwardFrom = $message['forward_from_chat']['title'] ?? 'unknown';
        }

        return [
            'id' => (string) ($message['message_id'] ?? '0'),
            'text' => $text,
            'reply_to_message_id' => isset($message['reply_to_message']) ? (string) $message['reply_to_message']['message_id'] : null,
            'has_media' => $hasMedia,
            'media_type' => $mediaType,
            'forward_from' => $forwardFrom,
            'timestamp' => isset($message['date']) ? date('c', (int) $message['date']) : null,
            'command_name' => null,
            'command_args' => null,
            'callback_data' => null,
            'callback_query_id' => null,
        ];
    }

    /**
     * @param array<string, mixed> $message
     */
    private function hasCommandEntity(array $message): bool
    {
        foreach (($message['entities'] ?? []) as $entity) {
            if (($entity['type'] ?? '') === 'bot_command' && ($entity['offset'] ?? -1) === 0) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param array<string, mixed> $chat
     * @param array<string, mixed> $sender
     * @param array<string, mixed> $message
     *
     * @return array<string, mixed>
     */
    private function buildEvent(
        string $eventType,
        string $channelId,
        array $chat,
        array $sender,
        array $message,
        int $updateId,
        string $traceId,
        string $requestId,
    ): array {
        return [
            'event_type' => $eventType,
            'platform' => 'telegram',
            'bot_id' => $channelId,
            'chat' => $chat,
            'sender' => $sender,
            'message' => $message,
            'trace_id' => $traceId,
            'request_id' => $requestId,
            'raw_update_id' => $updateId,
        ];
    }
}
