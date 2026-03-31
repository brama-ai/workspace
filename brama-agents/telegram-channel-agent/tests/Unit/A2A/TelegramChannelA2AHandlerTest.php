<?php

declare(strict_types=1);

namespace App\Tests\Unit\A2A;

use App\A2A\TelegramChannelA2AHandler;
use App\Telegram\TelegramApiClientInterface;
use App\Telegram\TelegramNormalizer;
use App\Telegram\TelegramSenderInterface;
use Codeception\Test\Unit;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;

final class TelegramChannelA2AHandlerTest extends Unit
{
    private TelegramApiClientInterface&MockObject $apiClient;
    private TelegramSenderInterface&MockObject $sender;
    private TelegramNormalizer $normalizer;
    private LoggerInterface&MockObject $logger;
    private TelegramChannelA2AHandler $handler;

    protected function setUp(): void
    {
        $this->apiClient = $this->createMock(TelegramApiClientInterface::class);
        $this->sender = $this->createMock(TelegramSenderInterface::class);
        $this->normalizer = new TelegramNormalizer();
        $this->logger = $this->createMock(LoggerInterface::class);

        $this->handler = new TelegramChannelA2AHandler(
            $this->apiClient,
            $this->sender,
            $this->normalizer,
            $this->logger,
            '/tmp/tasks',
            '/tmp/foundry.sh',
            '12345',
            'user1,user2',
        );
    }

    // ── Unknown skill ─────────────────────────────────────────────────────

    public function testUnknownSkillReturnsFailed(): void
    {
        $result = $this->handler->handle([
            'skill' => 'unknown.skill',
            'request_id' => 'req-001',
        ]);

        $this->assertSame('failed', $result['status']);
        $this->assertSame('req-001', $result['request_id']);
        $this->assertStringContainsString('Unknown skill', $result['error']);
    }

    public function testUnknownIntentAlsoReturnsFailed(): void
    {
        $result = $this->handler->handle([
            'intent' => 'unknown.intent',
            'request_id' => 'req-002',
        ]);

        $this->assertSame('failed', $result['status']);
        $this->assertStringContainsString('Unknown skill', $result['error']);
    }

    public function testHandleGeneratesRequestIdWhenMissing(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.getCapabilities',
        ]);

        $this->assertNotEmpty($result['request_id']);
    }

    // ── channel.getCapabilities ───────────────────────────────────────────

    public function testGetCapabilitiesReturnsCompleted(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.getCapabilities',
            'request_id' => 'req-caps',
        ]);

        $this->assertSame('completed', $result['status']);
        $this->assertSame('req-caps', $result['request_id']);
        $this->assertSame('telegram', $result['result']['channel_type']);
        $this->assertTrue($result['result']['threads']);
        $this->assertTrue($result['result']['media']);
        $this->assertSame(4096, $result['result']['maxMessage']);
    }

    // ── channel.normalizeInbound ──────────────────────────────────────────

    public function testNormalizeInboundRequiresRawPayload(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.normalizeInbound',
            'request_id' => 'req-norm-1',
            'input' => [],
        ]);

        $this->assertSame('failed', $result['status']);
        $this->assertStringContainsString('rawPayload is required', $result['error']);
    }

    public function testNormalizeInboundWithValidPayload(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.normalizeInbound',
            'request_id' => 'req-norm-2',
            'input' => [
                'rawPayload' => [
                    'update_id' => 100,
                    'message' => [
                        'message_id' => 1,
                        'date' => 1700000000,
                        'text' => 'Hello',
                        'chat' => ['id' => 999, 'type' => 'private'],
                        'from' => ['id' => 1, 'username' => 'u', 'first_name' => 'U', 'is_bot' => false],
                    ],
                ],
                'channelId' => 'bot123',
            ],
        ]);

        $this->assertSame('completed', $result['status']);
        $this->assertSame('req-norm-2', $result['request_id']);
        $this->assertCount(1, $result['result']['events']);
        $this->assertSame('message_created', $result['result']['events'][0]['event_type']);
    }

    public function testNormalizeInboundAcceptsSnakeCaseKeys(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.normalizeInbound',
            'request_id' => 'req-norm-3',
            'input' => [
                'raw_payload' => [
                    'update_id' => 101,
                    'message' => [
                        'message_id' => 2,
                        'date' => 1700000000,
                        'text' => 'Hi',
                        'chat' => ['id' => 100, 'type' => 'private'],
                        'from' => ['id' => 2, 'username' => 'v', 'first_name' => 'V', 'is_bot' => false],
                    ],
                ],
                'channel_id' => 'bot456',
            ],
        ]);

        $this->assertSame('completed', $result['status']);
        $this->assertCount(1, $result['result']['events']);
    }

    // ── channel.sendOutbound ──────────────────────────────────────────────

    public function testSendOutboundRequiresToken(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.sendOutbound',
            'request_id' => 'req-send-1',
            'input' => [
                'target' => ['chat_id' => '123'],
                'payload' => ['text' => 'Hello'],
            ],
        ]);

        $this->assertSame('failed', $result['status']);
        $this->assertStringContainsString('token is required', $result['error']);
    }

    public function testSendOutboundRequiresChatId(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.sendOutbound',
            'request_id' => 'req-send-2',
            'input' => [
                'token' => 'bot-token',
                'target' => [],
                'payload' => ['text' => 'Hello'],
            ],
        ]);

        $this->assertSame('failed', $result['status']);
        $this->assertStringContainsString('target.chat_id is required', $result['error']);
    }

    public function testSendOutboundSuccessfulTextMessage(): void
    {
        $this->sender->expects($this->once())
            ->method('send')
            ->with('bot-token', '123', 'Hello', $this->anything())
            ->willReturn(['ok' => true, 'result' => ['message_id' => 99]]);

        $result = $this->handler->handle([
            'skill' => 'channel.sendOutbound',
            'request_id' => 'req-send-3',
            'input' => [
                'token' => 'bot-token',
                'target' => ['chat_id' => '123'],
                'payload' => ['text' => 'Hello'],
            ],
        ]);

        $this->assertSame('completed', $result['status']);
        $this->assertTrue($result['result']['success']);
        $this->assertSame('99', $result['result']['external_message_id']);
    }

    public function testSendOutboundFailedDelivery(): void
    {
        $this->sender->expects($this->once())
            ->method('send')
            ->willReturn(['ok' => false, 'description' => 'Bad Request']);

        $result = $this->handler->handle([
            'skill' => 'channel.sendOutbound',
            'request_id' => 'req-send-4',
            'input' => [
                'token' => 'bot-token',
                'target' => ['chat_id' => '123'],
                'payload' => ['text' => 'Hello'],
            ],
        ]);

        $this->assertSame('failed', $result['status']);
        $this->assertFalse($result['result']['success']);
        $this->assertSame('Bad Request', $result['result']['error_message']);
    }

    public function testSendOutboundWithMarkdownContentType(): void
    {
        $this->sender->expects($this->once())
            ->method('send')
            ->with('bot-token', '123', 'Hello', $this->callback(function (array $opts): bool {
                return ($opts['parse_mode'] ?? '') === 'MarkdownV2';
            }))
            ->willReturn(['ok' => true, 'result' => ['message_id' => 1]]);

        $this->handler->handle([
            'skill' => 'channel.sendOutbound',
            'input' => [
                'token' => 'bot-token',
                'target' => ['chat_id' => '123'],
                'payload' => ['text' => 'Hello', 'content_type' => 'markdown'],
            ],
        ]);
    }

    public function testSendOutboundWithPhotoMediaType(): void
    {
        $this->sender->expects($this->once())
            ->method('sendPhoto')
            ->with('bot-token', '123', 'http://example.com/photo.jpg', null, $this->anything())
            ->willReturn(['ok' => true, 'result' => ['message_id' => 2]]);

        $result = $this->handler->handle([
            'skill' => 'channel.sendOutbound',
            'input' => [
                'token' => 'bot-token',
                'target' => ['chat_id' => '123'],
                'payload' => ['media_type' => 'photo', 'media_url' => 'http://example.com/photo.jpg'],
            ],
        ]);

        $this->assertSame('completed', $result['status']);
    }

    public function testSendOutboundWithMediaGroup(): void
    {
        $media = [['type' => 'photo', 'media' => 'url1'], ['type' => 'photo', 'media' => 'url2']];

        $this->sender->expects($this->once())
            ->method('sendMediaGroup')
            ->with('bot-token', '123', $media, $this->anything())
            ->willReturn(['ok' => true, 'result' => ['message_id' => 3]]);

        $result = $this->handler->handle([
            'skill' => 'channel.sendOutbound',
            'input' => [
                'token' => 'bot-token',
                'target' => ['chat_id' => '123'],
                'payload' => ['media_type' => 'media_group', 'media' => $media],
            ],
        ]);

        $this->assertSame('completed', $result['status']);
    }

    public function testSendOutboundWithThreadId(): void
    {
        $this->sender->expects($this->once())
            ->method('send')
            ->with('bot-token', '123', 'Hello', $this->callback(function (array $opts): bool {
                return ($opts['thread_id'] ?? null) === 42;
            }))
            ->willReturn(['ok' => true, 'result' => ['message_id' => 4]]);

        $this->handler->handle([
            'skill' => 'channel.sendOutbound',
            'input' => [
                'token' => 'bot-token',
                'target' => ['chat_id' => '123', 'thread_id' => '42'],
                'payload' => ['text' => 'Hello'],
            ],
        ]);
    }

    // ── channel.validateWebhook ───────────────────────────────────────────

    public function testValidateWebhookAllowsAllWhenNoSecret(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.validateWebhook',
            'request_id' => 'req-wh-1',
            'input' => [
                'headers' => [],
                'webhookSecret' => '',
            ],
        ]);

        $this->assertSame('completed', $result['status']);
        $this->assertTrue($result['result']['valid']);
    }

    public function testValidateWebhookValidSecret(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.validateWebhook',
            'request_id' => 'req-wh-2',
            'input' => [
                'headers' => ['X-Telegram-Bot-Api-Secret-Token' => 'my-secret'],
                'webhookSecret' => 'my-secret',
            ],
        ]);

        $this->assertSame('completed', $result['status']);
        $this->assertTrue($result['result']['valid']);
    }

    public function testValidateWebhookInvalidSecret(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.validateWebhook',
            'request_id' => 'req-wh-3',
            'input' => [
                'headers' => ['X-Telegram-Bot-Api-Secret-Token' => 'wrong-secret'],
                'webhookSecret' => 'my-secret',
            ],
        ]);

        $this->assertSame('completed', $result['status']);
        $this->assertFalse($result['result']['valid']);
    }

    public function testValidateWebhookCaseInsensitiveHeader(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.validateWebhook',
            'request_id' => 'req-wh-4',
            'input' => [
                'headers' => ['x-telegram-bot-api-secret-token' => 'my-secret'],
                'webhookSecret' => 'my-secret',
            ],
        ]);

        $this->assertSame('completed', $result['status']);
        $this->assertTrue($result['result']['valid']);
    }

    public function testValidateWebhookMissingHeaderReturnsFalse(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.validateWebhook',
            'request_id' => 'req-wh-5',
            'input' => [
                'headers' => [],
                'webhookSecret' => 'my-secret',
            ],
        ]);

        $this->assertSame('completed', $result['status']);
        $this->assertFalse($result['result']['valid']);
    }

    // ── channel.adminAction ───────────────────────────────────────────────

    public function testAdminActionRequiresToken(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.adminAction',
            'request_id' => 'req-admin-1',
            'input' => [
                'action' => 'test-connection',
                'params' => [],
            ],
        ]);

        $this->assertSame('failed', $result['status']);
        $this->assertStringContainsString('params.token is required', $result['error']);
    }

    public function testAdminActionUnknownActionReturnsFailed(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.adminAction',
            'request_id' => 'req-admin-2',
            'input' => [
                'action' => 'unknown-action',
                'params' => ['token' => 'bot-token'],
            ],
        ]);

        $this->assertSame('failed', $result['status']);
        $this->assertStringContainsString('Unknown admin action', $result['error']);
    }

    public function testAdminActionTestConnectionSuccess(): void
    {
        $this->apiClient->expects($this->once())
            ->method('getMe')
            ->with('bot-token')
            ->willReturn(['ok' => true, 'result' => ['id' => 1, 'username' => 'mybot']]);

        $result = $this->handler->handle([
            'skill' => 'channel.adminAction',
            'request_id' => 'req-admin-3',
            'input' => [
                'action' => 'test-connection',
                'params' => ['token' => 'bot-token'],
            ],
        ]);

        $this->assertSame('completed', $result['status']);
        $this->assertTrue($result['result']['success']);
        $this->assertSame(['id' => 1, 'username' => 'mybot'], $result['result']['bot_info']);
    }

    public function testAdminActionTestConnectionFailure(): void
    {
        $this->apiClient->expects($this->once())
            ->method('getMe')
            ->willReturn(['ok' => false, 'description' => 'Unauthorized']);

        $result = $this->handler->handle([
            'skill' => 'channel.adminAction',
            'request_id' => 'req-admin-4',
            'input' => [
                'action' => 'test-connection',
                'params' => ['token' => 'bad-token'],
            ],
        ]);

        $this->assertSame('failed', $result['status']);
        $this->assertFalse($result['result']['success']);
        $this->assertSame('Unauthorized', $result['result']['error']);
    }

    public function testAdminActionSetWebhookRequiresUrl(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.adminAction',
            'request_id' => 'req-admin-5',
            'input' => [
                'action' => 'set-webhook',
                'params' => ['token' => 'bot-token'],
            ],
        ]);

        $this->assertSame('failed', $result['status']);
        $this->assertStringContainsString('params.url is required', $result['error']);
    }

    public function testAdminActionSetWebhookSuccess(): void
    {
        $this->apiClient->expects($this->once())
            ->method('setWebhook')
            ->with('bot-token', $this->callback(function (array $params): bool {
                return $params['url'] === 'https://example.com/webhook';
            }))
            ->willReturn(['ok' => true, 'description' => 'Webhook was set']);

        $result = $this->handler->handle([
            'skill' => 'channel.adminAction',
            'request_id' => 'req-admin-6',
            'input' => [
                'action' => 'set-webhook',
                'params' => ['token' => 'bot-token', 'url' => 'https://example.com/webhook'],
            ],
        ]);

        $this->assertSame('completed', $result['status']);
        $this->assertTrue($result['result']['success']);
    }

    public function testAdminActionDeleteWebhook(): void
    {
        $this->apiClient->expects($this->once())
            ->method('deleteWebhook')
            ->with('bot-token')
            ->willReturn(['ok' => true, 'description' => 'Webhook deleted']);

        $result = $this->handler->handle([
            'skill' => 'channel.adminAction',
            'request_id' => 'req-admin-7',
            'input' => [
                'action' => 'delete-webhook',
                'params' => ['token' => 'bot-token'],
            ],
        ]);

        $this->assertSame('completed', $result['status']);
        $this->assertTrue($result['result']['success']);
    }

    public function testAdminActionWebhookInfo(): void
    {
        $webhookInfo = ['url' => 'https://example.com/webhook', 'pending_update_count' => 0];

        $this->apiClient->expects($this->once())
            ->method('getWebhookInfo')
            ->with('bot-token')
            ->willReturn(['ok' => true, 'result' => $webhookInfo]);

        $result = $this->handler->handle([
            'skill' => 'channel.adminAction',
            'request_id' => 'req-admin-8',
            'input' => [
                'action' => 'webhook-info',
                'params' => ['token' => 'bot-token'],
            ],
        ]);

        $this->assertSame('completed', $result['status']);
        $this->assertSame($webhookInfo, $result['result']['webhook_info']);
    }

    // ── channel.hitl.pollQuestions ────────────────────────────────────────

    public function testHitlPollQuestionsRequiresTokenAndChatId(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.hitl.pollQuestions',
            'request_id' => 'req-hitl-1',
            'input' => [],
        ]);

        $this->assertSame('failed', $result['status']);
        $this->assertStringContainsString('token and chat_id are required', $result['error']);
    }

    public function testHitlPollQuestionsWithNonExistentTasksRoot(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.hitl.pollQuestions',
            'request_id' => 'req-hitl-2',
            'input' => [
                'token' => 'bot-token',
                'chat_id' => '12345',
                'tasks_root' => '/nonexistent/path',
            ],
        ]);

        $this->assertSame('completed', $result['status']);
        $this->assertSame(0, $result['result']['waiting_tasks']);
        $this->assertSame([], $result['result']['notified']);
    }

    // ── channel.hitl.handleAnswer ─────────────────────────────────────────

    public function testHitlHandleAnswerRequiresAllFields(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.hitl.handleAnswer',
            'request_id' => 'req-hitl-3',
            'input' => [
                'task_slug' => 'my-task',
                'question_id' => 'q-001',
                // missing answer
            ],
        ]);

        $this->assertSame('failed', $result['status']);
        $this->assertStringContainsString('task_slug, question_id, and answer are required', $result['error']);
    }

    public function testHitlHandleAnswerTaskNotFound(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.hitl.handleAnswer',
            'request_id' => 'req-hitl-4',
            'input' => [
                'task_slug' => 'nonexistent-task',
                'question_id' => 'q-001',
                'answer' => 'yes',
            ],
        ]);

        $this->assertSame('failed', $result['status']);
        $this->assertStringContainsString('Task not found', $result['error']);
    }

    // ── Skill alias via intent ────────────────────────────────────────────

    public function testHandleViaIntentField(): void
    {
        $result = $this->handler->handle([
            'intent' => 'channel.getCapabilities',
            'request_id' => 'req-intent-1',
        ]);

        $this->assertSame('completed', $result['status']);
        $this->assertSame('telegram', $result['result']['channel_type']);
    }

    public function testHandleViaPayloadField(): void
    {
        $result = $this->handler->handle([
            'skill' => 'channel.normalizeInbound',
            'request_id' => 'req-payload-1',
            'payload' => [
                'rawPayload' => [
                    'update_id' => 999,
                    'message' => [
                        'message_id' => 1,
                        'date' => 1700000000,
                        'text' => 'Test',
                        'chat' => ['id' => 1, 'type' => 'private'],
                        'from' => ['id' => 1, 'username' => 'u', 'first_name' => 'U', 'is_bot' => false],
                    ],
                ],
                'channelId' => 'bot1',
            ],
        ]);

        $this->assertSame('completed', $result['status']);
    }
}
