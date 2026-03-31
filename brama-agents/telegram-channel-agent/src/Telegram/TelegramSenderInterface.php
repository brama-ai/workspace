<?php

declare(strict_types=1);

namespace App\Telegram;

interface TelegramSenderInterface
{
    /**
     * @param array<string, mixed> $options
     *
     * @return array<string, mixed>
     */
    public function send(string $token, string $chatId, string $text, array $options = []): array;

    /**
     * @param array<string, mixed> $options
     *
     * @return array<string, mixed>
     */
    public function sendPhoto(string $token, string $chatId, string $photo, ?string $caption = null, array $options = []): array;

    /**
     * @param list<array<string, mixed>> $media
     * @param array<string, mixed>       $options
     *
     * @return array<string, mixed>
     */
    public function sendMediaGroup(string $token, string $chatId, array $media, array $options = []): array;

    /**
     * @return array<string, mixed>
     */
    public function answerCallbackQuery(string $token, string $callbackQueryId, ?string $text = null, bool $showAlert = false): array;

    /**
     * @param array<string, mixed> $replyMarkup
     *
     * @return array<string, mixed>
     */
    public function editMessageReplyMarkup(string $token, string $chatId, int $messageId, array $replyMarkup): array;
}
