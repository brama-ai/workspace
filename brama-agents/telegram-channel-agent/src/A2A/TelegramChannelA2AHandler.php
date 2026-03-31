<?php

declare(strict_types=1);

namespace App\A2A;

use App\Telegram\TelegramApiClient;
use App\Telegram\TelegramNormalizer;
use App\Telegram\TelegramSender;
use Psr\Log\LoggerInterface;

/**
 * Main A2A handler for the Telegram Channel Agent.
 * Implements all channel.* skills defined in the A2A contract.
 */
final class TelegramChannelA2AHandler
{
    public function __construct(
        private readonly TelegramApiClient $apiClient,
        private readonly TelegramSender $sender,
        private readonly TelegramNormalizer $normalizer,
        private readonly LoggerInterface $logger,
        private readonly string $tasksRoot,
        private readonly string $foundrySh,
        private readonly string $pipelineChatId,
        private readonly string $allowedUsers,
    ) {
    }

    /**
     * @param array<string, mixed> $request
     *
     * @return array<string, mixed>
     */
    public function handle(array $request): array
    {
        $skill = (string) ($request['skill'] ?? $request['intent'] ?? '');
        $requestId = (string) ($request['request_id'] ?? uniqid('a2a_', true));

        /** @var array<string, mixed> $input */
        $input = $request['input'] ?? $request['payload'] ?? [];

        return match ($skill) {
            'channel.normalizeInbound' => $this->handleNormalizeInbound($input, $requestId),
            'channel.sendOutbound' => $this->handleSendOutbound($input, $requestId),
            'channel.validateWebhook' => $this->handleValidateWebhook($input, $requestId),
            'channel.getCapabilities' => $this->handleGetCapabilities($requestId),
            'channel.adminAction' => $this->handleAdminAction($input, $requestId),
            'channel.hitl.pollQuestions' => $this->handleHitlPollQuestions($input, $requestId),
            'channel.hitl.handleAnswer' => $this->handleHitlHandleAnswer($input, $requestId),
            default => $this->handleUnknown($skill, $requestId),
        };
    }

    // ── channel.normalizeInbound ──────────────────────────────────────────

    /**
     * @param array<string, mixed> $input
     *
     * @return array<string, mixed>
     */
    private function handleNormalizeInbound(array $input, string $requestId): array
    {
        /** @var array<string, mixed> $rawPayload */
        $rawPayload = $input['rawPayload'] ?? $input['raw_payload'] ?? [];
        $channelId = (string) ($input['channelId'] ?? $input['channel_id'] ?? '');

        if ([] === $rawPayload) {
            return [
                'status' => 'failed',
                'request_id' => $requestId,
                'error' => 'rawPayload is required',
            ];
        }

        $events = $this->normalizer->normalize($rawPayload, $channelId);

        $this->logger->info('channel.normalizeInbound completed', [
            'channel_id' => $channelId,
            'events_count' => count($events),
            'request_id' => $requestId,
        ]);

        return [
            'status' => 'completed',
            'request_id' => $requestId,
            'result' => [
                'events' => $events,
            ],
        ];
    }

    // ── channel.sendOutbound ──────────────────────────────────────────────

    /**
     * @param array<string, mixed> $input
     *
     * @return array<string, mixed>
     */
    private function handleSendOutbound(array $input, string $requestId): array
    {
        $token = (string) ($input['token'] ?? $input['credentialRef'] ?? $input['credential_ref'] ?? '');
        /** @var array<string, mixed> $target */
        $target = $input['target'] ?? [];
        /** @var array<string, mixed> $payload */
        $payload = $input['payload'] ?? [];

        if ('' === $token) {
            return [
                'status' => 'failed',
                'request_id' => $requestId,
                'error' => 'token is required',
            ];
        }

        $chatId = (string) ($target['chat_id'] ?? $target['address'] ?? '');
        $threadId = isset($target['thread_id']) ? (int) $target['thread_id'] : null;
        $text = (string) ($payload['text'] ?? '');
        $contentType = (string) ($payload['content_type'] ?? $payload['contentType'] ?? 'text');

        if ('' === $chatId) {
            return [
                'status' => 'failed',
                'request_id' => $requestId,
                'error' => 'target.chat_id is required',
            ];
        }

        $options = [];
        if (null !== $threadId) {
            $options['thread_id'] = $threadId;
        }

        // Map content_type to parse_mode
        if ('markdown' === $contentType) {
            $options['parse_mode'] = 'MarkdownV2';
        } elseif ('card' === $contentType) {
            $options['parse_mode'] = 'HTML';
        }

        /** @var array<string, mixed> $replyMarkup */
        $replyMarkup = $payload['reply_markup'] ?? [];
        if ([] !== $replyMarkup) {
            $options['reply_markup'] = $replyMarkup;
        }

        // Handle different content types
        $mediaType = (string) ($payload['media_type'] ?? '');
        $mediaUrl = (string) ($payload['media_url'] ?? '');

        if ('photo' === $mediaType && '' !== $mediaUrl) {
            $result = $this->sender->sendPhoto($token, $chatId, $mediaUrl, '' !== $text ? $text : null, $options);
        } elseif ('media_group' === $mediaType) {
            /** @var list<array<string, mixed>> $media */
            $media = $payload['media'] ?? [];
            $result = $this->sender->sendMediaGroup($token, $chatId, $media, $options);
        } else {
            $result = $this->sender->send($token, $chatId, $text, $options);
        }

        $success = (bool) ($result['ok'] ?? false);
        $externalMessageId = null;
        if ($success) {
            /** @var array<string, mixed> $resultMessage */
            $resultMessage = $result['result'] ?? [];
            $externalMessageId = isset($resultMessage['message_id']) ? (string) $resultMessage['message_id'] : null;
        }

        $this->logger->info('channel.sendOutbound completed', [
            'chat_id' => $chatId,
            'success' => $success,
            'request_id' => $requestId,
        ]);

        return [
            'status' => $success ? 'completed' : 'failed',
            'request_id' => $requestId,
            'result' => [
                'success' => $success,
                'external_message_id' => $externalMessageId,
                'error_message' => $success ? null : ($result['description'] ?? 'Delivery failed'),
            ],
        ];
    }

    // ── channel.validateWebhook ───────────────────────────────────────────

    /**
     * @param array<string, mixed> $input
     *
     * @return array<string, mixed>
     */
    private function handleValidateWebhook(array $input, string $requestId): array
    {
        /** @var array<string, mixed> $headers */
        $headers = $input['headers'] ?? [];
        $expectedSecret = (string) ($input['webhookSecret'] ?? $input['webhook_secret'] ?? $_ENV['TELEGRAM_WEBHOOK_SECRET'] ?? '');

        // If no secret configured, allow all (open webhook)
        if ('' === $expectedSecret) {
            return [
                'status' => 'completed',
                'request_id' => $requestId,
                'result' => ['valid' => true],
            ];
        }

        // Check X-Telegram-Bot-Api-Secret-Token header
        $receivedSecret = '';
        foreach ($headers as $name => $value) {
            if (strtolower((string) $name) === 'x-telegram-bot-api-secret-token') {
                $receivedSecret = is_array($value) ? (string) ($value[0] ?? '') : (string) $value;
                break;
            }
        }

        $valid = hash_equals($expectedSecret, $receivedSecret);

        $this->logger->info('channel.validateWebhook completed', [
            'valid' => $valid,
            'request_id' => $requestId,
        ]);

        return [
            'status' => 'completed',
            'request_id' => $requestId,
            'result' => ['valid' => $valid],
        ];
    }

    // ── channel.getCapabilities ───────────────────────────────────────────

    /**
     * @return array<string, mixed>
     */
    private function handleGetCapabilities(string $requestId): array
    {
        return [
            'status' => 'completed',
            'request_id' => $requestId,
            'result' => [
                'channel_type' => 'telegram',
                'threads' => true,
                'reactions' => false,
                'editing' => true,
                'media' => true,
                'mediaGroups' => true,
                'callbackQueries' => true,
                'maxMessage' => 4096,
                'maxCaption' => 1024,
            ],
        ];
    }

    // ── channel.adminAction ───────────────────────────────────────────────

    /**
     * @param array<string, mixed> $input
     *
     * @return array<string, mixed>
     */
    private function handleAdminAction(array $input, string $requestId): array
    {
        $action = (string) ($input['action'] ?? '');
        /** @var array<string, mixed> $params */
        $params = $input['params'] ?? [];

        $token = (string) ($params['token'] ?? '');

        if ('' === $token) {
            return [
                'status' => 'failed',
                'request_id' => $requestId,
                'error' => 'params.token is required',
            ];
        }

        return match ($action) {
            'test-connection' => $this->adminTestConnection($token, $requestId),
            'set-webhook' => $this->adminSetWebhook($token, $params, $requestId),
            'delete-webhook' => $this->adminDeleteWebhook($token, $requestId),
            'webhook-info' => $this->adminWebhookInfo($token, $requestId),
            default => [
                'status' => 'failed',
                'request_id' => $requestId,
                'error' => sprintf('Unknown admin action: %s', $action),
            ],
        };
    }

    /**
     * @return array<string, mixed>
     */
    private function adminTestConnection(string $token, string $requestId): array
    {
        $result = $this->apiClient->getMe($token);
        $success = (bool) ($result['ok'] ?? false);

        $this->logger->info('admin test-connection', [
            'success' => $success,
            'request_id' => $requestId,
        ]);

        return [
            'status' => $success ? 'completed' : 'failed',
            'request_id' => $requestId,
            'result' => [
                'success' => $success,
                'bot_info' => $success ? ($result['result'] ?? null) : null,
                'error' => $success ? null : ($result['description'] ?? 'Connection failed'),
            ],
        ];
    }

    /**
     * @param array<string, mixed> $params
     *
     * @return array<string, mixed>
     */
    private function adminSetWebhook(string $token, array $params, string $requestId): array
    {
        $url = (string) ($params['url'] ?? '');
        if ('' === $url) {
            return [
                'status' => 'failed',
                'request_id' => $requestId,
                'error' => 'params.url is required for set-webhook',
            ];
        }

        $webhookParams = ['url' => $url];
        if (isset($params['secret'])) {
            $webhookParams['secret_token'] = (string) $params['secret'];
        }
        if (isset($params['max_connections'])) {
            $webhookParams['max_connections'] = (int) $params['max_connections'];
        }

        $result = $this->apiClient->setWebhook($token, $webhookParams);
        $success = (bool) ($result['ok'] ?? false);

        $this->logger->info('admin set-webhook', [
            'url' => $url,
            'success' => $success,
            'request_id' => $requestId,
        ]);

        return [
            'status' => $success ? 'completed' : 'failed',
            'request_id' => $requestId,
            'result' => [
                'success' => $success,
                'description' => $result['description'] ?? ($success ? 'Webhook set' : 'Failed'),
            ],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function adminDeleteWebhook(string $token, string $requestId): array
    {
        $result = $this->apiClient->deleteWebhook($token);
        $success = (bool) ($result['ok'] ?? false);

        $this->logger->info('admin delete-webhook', [
            'success' => $success,
            'request_id' => $requestId,
        ]);

        return [
            'status' => $success ? 'completed' : 'failed',
            'request_id' => $requestId,
            'result' => [
                'success' => $success,
                'description' => $result['description'] ?? ($success ? 'Webhook deleted' : 'Failed'),
            ],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function adminWebhookInfo(string $token, string $requestId): array
    {
        $result = $this->apiClient->getWebhookInfo($token);
        $success = (bool) ($result['ok'] ?? false);

        $this->logger->info('admin webhook-info', [
            'success' => $success,
            'request_id' => $requestId,
        ]);

        return [
            'status' => $success ? 'completed' : 'failed',
            'request_id' => $requestId,
            'result' => [
                'success' => $success,
                'webhook_info' => $success ? ($result['result'] ?? null) : null,
                'error' => $success ? null : ($result['description'] ?? 'Failed'),
            ],
        ];
    }

    // ── channel.hitl.pollQuestions ────────────────────────────────────────

    /**
     * @param array<string, mixed> $input
     *
     * @return array<string, mixed>
     */
    private function handleHitlPollQuestions(array $input, string $requestId): array
    {
        $tasksRoot = (string) ($input['tasks_root'] ?? $this->tasksRoot);
        $chatId = (string) ($input['chat_id'] ?? $this->pipelineChatId);
        $token = (string) ($input['token'] ?? '');

        if ('' === $token || '' === $chatId) {
            return [
                'status' => 'failed',
                'request_id' => $requestId,
                'error' => 'token and chat_id are required',
            ];
        }

        $waitingTasks = $this->findWaitingTasks($tasksRoot);
        $notified = [];

        foreach ($waitingTasks as $task) {
            $summary = $this->formatTaskSummary($task);
            $keyboard = $this->buildTaskKeyboard($task['slug']);

            $result = $this->apiClient->sendMessage($token, [
                'chat_id' => $chatId,
                'text' => $summary,
                'parse_mode' => 'HTML',
                'reply_markup' => ['inline_keyboard' => $keyboard],
            ]);

            if ($result['ok'] ?? false) {
                $notified[] = $task['slug'];
            }
        }

        $this->logger->info('channel.hitl.pollQuestions completed', [
            'tasks_found' => count($waitingTasks),
            'notified' => count($notified),
            'request_id' => $requestId,
        ]);

        return [
            'status' => 'completed',
            'request_id' => $requestId,
            'result' => [
                'waiting_tasks' => count($waitingTasks),
                'notified' => $notified,
            ],
        ];
    }

    // ── channel.hitl.handleAnswer ─────────────────────────────────────────

    /**
     * @param array<string, mixed> $input
     *
     * @return array<string, mixed>
     */
    private function handleHitlHandleAnswer(array $input, string $requestId): array
    {
        $taskSlug = (string) ($input['task_slug'] ?? '');
        $questionId = (string) ($input['question_id'] ?? '');
        $answer = (string) ($input['answer'] ?? '');
        $answeredBy = (string) ($input['answered_by'] ?? 'human');

        if ('' === $taskSlug || '' === $questionId || '' === $answer) {
            return [
                'status' => 'failed',
                'request_id' => $requestId,
                'error' => 'task_slug, question_id, and answer are required',
            ];
        }

        $taskDir = $this->findTaskDir($this->tasksRoot, $taskSlug);
        if (null === $taskDir) {
            return [
                'status' => 'failed',
                'request_id' => $requestId,
                'error' => sprintf('Task not found: %s', $taskSlug),
            ];
        }

        $success = $this->writeAnswer($taskDir, $questionId, $answer, $answeredBy);
        if (!$success) {
            return [
                'status' => 'failed',
                'request_id' => $requestId,
                'error' => 'Failed to write answer to qa.json',
            ];
        }

        // Check if all blocking questions are answered → trigger resume
        $qaData = $this->readQA($taskDir);
        $resumed = false;
        $resumeOutput = '';

        if (null !== $qaData && $this->allBlockingAnswered($qaData['questions'] ?? [])) {
            $resumeResult = $this->triggerResumeQA($taskSlug);
            $resumed = $resumeResult['success'];
            $resumeOutput = $resumeResult['output'];
        }

        $this->logger->info('channel.hitl.handleAnswer completed', [
            'task_slug' => $taskSlug,
            'question_id' => $questionId,
            'resumed' => $resumed,
            'request_id' => $requestId,
        ]);

        return [
            'status' => 'completed',
            'request_id' => $requestId,
            'result' => [
                'answer_saved' => true,
                'pipeline_resumed' => $resumed,
                'resume_output' => $resumeOutput,
            ],
        ];
    }

    // ── HITL helpers ──────────────────────────────────────────────────────

    /**
     * @return list<array<string, mixed>>
     */
    private function findWaitingTasks(string $tasksRoot): array
    {
        $waiting = [];

        if (!is_dir($tasksRoot)) {
            return $waiting;
        }

        $entries = scandir($tasksRoot);
        if (false === $entries) {
            return $waiting;
        }

        foreach ($entries as $entry) {
            if (!str_contains($entry, '--foundry')) {
                continue;
            }

            $taskDir = $tasksRoot.'/'.$entry;
            $statePath = $taskDir.'/state.json';

            if (!file_exists($statePath)) {
                continue;
            }

            $stateJson = file_get_contents($statePath);
            if (false === $stateJson) {
                continue;
            }

            /** @var array<string, mixed>|null $state */
            $state = json_decode($stateJson, true);
            if (!is_array($state) || ($state['status'] ?? '') !== 'waiting_answer') {
                continue;
            }

            $qaData = $this->readQA($taskDir);
            if (null === $qaData) {
                continue;
            }

            $slug = (string) preg_replace('/--foundry.*/', '', $entry);
            $waiting[] = [
                'slug' => $slug,
                'task_dir' => $taskDir,
                'waiting_agent' => (string) ($state['waiting_agent'] ?? 'unknown'),
                'questions' => $qaData['questions'] ?? [],
                'waiting_since' => $state['waiting_since'] ?? null,
            ];
        }

        return $waiting;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function readQA(string $taskDir): ?array
    {
        $qaPath = $taskDir.'/qa.json';
        if (!file_exists($qaPath)) {
            return null;
        }

        $content = file_get_contents($qaPath);
        if (false === $content) {
            return null;
        }

        /** @var array<string, mixed>|null $data */
        $data = json_decode($content, true);

        return is_array($data) ? $data : null;
    }

    private function writeAnswer(string $taskDir, string $questionId, string $answer, string $answeredBy): bool
    {
        $qaPath = $taskDir.'/qa.json';
        if (!file_exists($qaPath)) {
            return false;
        }

        $content = file_get_contents($qaPath);
        if (false === $content) {
            return false;
        }

        /** @var array<string, mixed>|null $data */
        $data = json_decode($content, true);
        if (!is_array($data)) {
            return false;
        }

        $found = false;
        /** @var array<string, mixed> $question */
        foreach ($data['questions'] as &$question) {
            if ($question['id'] === $questionId) {
                $question['answer'] = $answer;
                $question['answered_at'] = date('c');
                $question['answered_by'] = $answeredBy;
                $question['answer_source'] = 'telegram';
                $found = true;
                break;
            }
        }
        unset($question);

        if (!$found) {
            return false;
        }

        $written = file_put_contents($qaPath, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)."\n");

        return false !== $written;
    }

    /**
     * @param list<array<string, mixed>> $questions
     */
    private function allBlockingAnswered(array $questions): bool
    {
        foreach ($questions as $q) {
            if (($q['priority'] ?? '') === 'blocking' && null === ($q['answer'] ?? null)) {
                return false;
            }
        }

        return true;
    }

    /**
     * @return array{success: bool, output: string}
     */
    private function triggerResumeQA(string $taskSlug): array
    {
        $foundryShPath = $this->foundrySh;
        $escapedSlug = escapeshellarg($taskSlug);
        $escapedPath = escapeshellarg($foundryShPath);

        $output = '';
        $returnCode = 0;

        exec(sprintf('%s resume-qa %s 2>&1', $escapedPath, $escapedSlug), $outputLines, $returnCode);
        $output = implode("\n", $outputLines);

        return [
            'success' => 0 === $returnCode,
            'output' => $output,
        ];
    }

    private function findTaskDir(string $tasksRoot, string $slug): ?string
    {
        if (!is_dir($tasksRoot)) {
            return null;
        }

        $entries = scandir($tasksRoot);
        if (false === $entries) {
            return null;
        }

        foreach ($entries as $entry) {
            if (str_starts_with($entry, $slug.'--foundry')) {
                return $tasksRoot.'/'.$entry;
            }
        }

        return null;
    }

    /**
     * @param array<string, mixed> $task
     */
    private function formatTaskSummary(array $task): string
    {
        /** @var list<array<string, mixed>> $questions */
        $questions = $task['questions'] ?? [];
        $total = count($questions);
        $answered = count(array_filter($questions, static fn (array $q): bool => null !== ($q['answer'] ?? null)));
        $blocking = count(array_filter($questions, static fn (array $q): bool => ($q['priority'] ?? '') === 'blocking' && null === ($q['answer'] ?? null)));

        $waitingAgent = htmlspecialchars((string) ($task['waiting_agent'] ?? 'unknown'), ENT_QUOTES | ENT_HTML5);
        $slug = htmlspecialchars((string) ($task['slug'] ?? ''), ENT_QUOTES | ENT_HTML5);

        $lines = [
            sprintf('<b>%s</b> needs your input', $waitingAgent),
            sprintf('<code>%s</code>', $slug),
            '',
            sprintf('%d/%d answered%s', $answered, $total, $blocking > 0 ? sprintf(' | %d blocking', $blocking) : ''),
            '',
        ];

        foreach ($questions as $i => $q) {
            $icon = null !== ($q['answer'] ?? null) ? '✅' : (($q['priority'] ?? '') === 'blocking' ? '🔴' : '🟡');
            $questionText = htmlspecialchars(mb_substr((string) ($q['question'] ?? ''), 0, 60), ENT_QUOTES | ENT_HTML5);
            $ellipsis = mb_strlen((string) ($q['question'] ?? '')) > 60 ? '...' : '';
            $lines[] = sprintf('%s Q%d: %s%s', $icon, $i + 1, $questionText, $ellipsis);
        }

        return implode("\n", $lines);
    }

    /**
     * @return list<list<array<string, string>>>
     */
    private function buildTaskKeyboard(string $taskSlug): array
    {
        return [
            [
                ['text' => '📋 View questions', 'callback_data' => sprintf('hitl:view:%s', $taskSlug)],
            ],
        ];
    }

    // ── Unknown skill ─────────────────────────────────────────────────────

    /**
     * @return array<string, mixed>
     */
    private function handleUnknown(string $skill, string $requestId): array
    {
        $this->logger->warning('Unknown skill received', [
            'skill' => $skill,
            'request_id' => $requestId,
        ]);

        return [
            'status' => 'failed',
            'request_id' => $requestId,
            'error' => sprintf('Unknown skill: %s', $skill),
        ];
    }
}
