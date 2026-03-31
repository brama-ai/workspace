<?php

declare(strict_types=1);

namespace App\Tests\Unit\Telegram;

use App\Telegram\TelegramNormalizer;
use Codeception\Test\Unit;

final class TelegramNormalizerTest extends Unit
{
    private TelegramNormalizer $normalizer;

    protected function setUp(): void
    {
        $this->normalizer = new TelegramNormalizer();
    }

    public function testNormalizeReturnsEmptyForUnknownUpdate(): void
    {
        $result = $this->normalizer->normalize(['update_id' => 1], 'bot123');

        $this->assertSame([], $result);
    }

    public function testNormalizeTextMessage(): void
    {
        $update = [
            'update_id' => 100,
            'message' => [
                'message_id' => 42,
                'date' => 1700000000,
                'text' => 'Hello world',
                'chat' => ['id' => 999, 'type' => 'private'],
                'from' => ['id' => 1, 'username' => 'testuser', 'first_name' => 'Test', 'is_bot' => false],
            ],
        ];

        $events = $this->normalizer->normalize($update, 'bot123');

        $this->assertCount(1, $events);
        $event = $events[0];

        $this->assertSame('message_created', $event['event_type']);
        $this->assertSame('telegram', $event['platform']);
        $this->assertSame('bot123', $event['bot_id']);
        $this->assertSame('999', $event['chat']['id']);
        $this->assertSame('private', $event['chat']['type']);
        $this->assertSame('1', $event['sender']['id']);
        $this->assertSame('testuser', $event['sender']['username']);
        $this->assertSame('Test', $event['sender']['first_name']);
        $this->assertFalse($event['sender']['is_bot']);
        $this->assertSame('42', $event['message']['id']);
        $this->assertSame('Hello world', $event['message']['text']);
        $this->assertFalse($event['message']['has_media']);
        $this->assertNull($event['message']['media_type']);
        $this->assertSame(100, $event['raw_update_id']);
        $this->assertNotEmpty($event['trace_id']);
        $this->assertNotEmpty($event['request_id']);
    }

    public function testNormalizeBotCommand(): void
    {
        $update = [
            'update_id' => 200,
            'message' => [
                'message_id' => 10,
                'date' => 1700000000,
                'text' => '/start hello',
                'chat' => ['id' => 100, 'type' => 'group'],
                'from' => ['id' => 5, 'username' => 'user5', 'first_name' => 'User', 'is_bot' => false],
                'entities' => [
                    ['type' => 'bot_command', 'offset' => 0, 'length' => 6],
                ],
            ],
        ];

        $events = $this->normalizer->normalize($update, 'bot456');

        $this->assertCount(1, $events);
        $event = $events[0];

        $this->assertSame('command_received', $event['event_type']);
        $this->assertSame('/start', $event['message']['command_name']);
        $this->assertSame('hello', $event['message']['command_args']);
    }

    public function testNormalizeBotCommandWithBotnameSuffix(): void
    {
        $update = [
            'update_id' => 201,
            'message' => [
                'message_id' => 11,
                'date' => 1700000000,
                'text' => '/start@mybot',
                'chat' => ['id' => 100, 'type' => 'group'],
                'from' => ['id' => 5, 'username' => 'user5', 'first_name' => 'User', 'is_bot' => false],
                'entities' => [
                    ['type' => 'bot_command', 'offset' => 0, 'length' => 12],
                ],
            ],
        ];

        $events = $this->normalizer->normalize($update, 'bot456');

        $this->assertCount(1, $events);
        $this->assertSame('/start', $events[0]['message']['command_name']);
        $this->assertNull($events[0]['message']['command_args']);
    }

    public function testNormalizeCallbackQuery(): void
    {
        $update = [
            'update_id' => 300,
            'callback_query' => [
                'id' => 'cq123',
                'data' => 'hitl:view:my-task',
                'from' => ['id' => 7, 'username' => 'cbuser', 'first_name' => 'CB', 'is_bot' => false],
                'message' => [
                    'message_id' => 55,
                    'chat' => ['id' => 200, 'type' => 'group'],
                ],
            ],
        ];

        $events = $this->normalizer->normalize($update, 'bot789');

        $this->assertCount(1, $events);
        $event = $events[0];

        $this->assertSame('callback_query', $event['event_type']);
        $this->assertSame('hitl:view:my-task', $event['message']['callback_data']);
        $this->assertSame('cq123', $event['message']['callback_query_id']);
        $this->assertSame('7', $event['sender']['id']);
    }

    public function testNormalizeChannelPost(): void
    {
        $update = [
            'update_id' => 400,
            'channel_post' => [
                'message_id' => 77,
                'date' => 1700000000,
                'text' => 'Channel announcement',
                'chat' => ['id' => -1001234567890, 'type' => 'channel', 'title' => 'My Channel'],
                'sender_chat' => ['id' => -1001234567890, 'title' => 'My Channel'],
            ],
        ];

        $events = $this->normalizer->normalize($update, 'bot999');

        $this->assertCount(1, $events);
        $this->assertSame('channel_post_created', $events[0]['event_type']);
        $this->assertSame('My Channel', $events[0]['chat']['title']);
    }

    public function testNormalizeEditedChannelPost(): void
    {
        $update = [
            'update_id' => 401,
            'edited_channel_post' => [
                'message_id' => 78,
                'date' => 1700000000,
                'text' => 'Edited announcement',
                'chat' => ['id' => -1001234567890, 'type' => 'channel', 'title' => 'My Channel'],
            ],
        ];

        $events = $this->normalizer->normalize($update, 'bot999');

        $this->assertCount(1, $events);
        $this->assertSame('channel_post_edited', $events[0]['event_type']);
    }

    public function testNormalizeEditedMessage(): void
    {
        $update = [
            'update_id' => 500,
            'edited_message' => [
                'message_id' => 20,
                'date' => 1700000000,
                'text' => 'Edited text',
                'chat' => ['id' => 100, 'type' => 'private'],
                'from' => ['id' => 1, 'username' => 'u', 'first_name' => 'U', 'is_bot' => false],
            ],
        ];

        $events = $this->normalizer->normalize($update, 'bot1');

        $this->assertCount(1, $events);
        $this->assertSame('message_edited', $events[0]['event_type']);
    }

    public function testNormalizeMemberJoined(): void
    {
        $update = [
            'update_id' => 600,
            'message' => [
                'message_id' => 30,
                'date' => 1700000000,
                'chat' => ['id' => 100, 'type' => 'group'],
                'from' => ['id' => 1, 'username' => 'admin', 'first_name' => 'Admin', 'is_bot' => false],
                'new_chat_members' => [
                    ['id' => 10, 'username' => 'newuser', 'first_name' => 'New', 'is_bot' => false],
                    ['id' => 11, 'username' => 'newuser2', 'first_name' => 'New2', 'is_bot' => false],
                ],
            ],
        ];

        $events = $this->normalizer->normalize($update, 'bot1');

        $this->assertCount(2, $events);
        $this->assertSame('member_joined', $events[0]['event_type']);
        $this->assertSame('10', $events[0]['sender']['id']);
        $this->assertSame('member_joined', $events[1]['event_type']);
        $this->assertSame('11', $events[1]['sender']['id']);
    }

    public function testNormalizeMemberLeft(): void
    {
        $update = [
            'update_id' => 700,
            'message' => [
                'message_id' => 31,
                'date' => 1700000000,
                'chat' => ['id' => 100, 'type' => 'group'],
                'from' => ['id' => 1, 'username' => 'admin', 'first_name' => 'Admin', 'is_bot' => false],
                'left_chat_member' => ['id' => 20, 'username' => 'leftuser', 'first_name' => 'Left', 'is_bot' => false],
            ],
        ];

        $events = $this->normalizer->normalize($update, 'bot1');

        $this->assertCount(1, $events);
        $this->assertSame('member_left', $events[0]['event_type']);
        $this->assertSame('20', $events[0]['sender']['id']);
    }

    public function testNormalizeMessageWithPhoto(): void
    {
        $update = [
            'update_id' => 800,
            'message' => [
                'message_id' => 50,
                'date' => 1700000000,
                'caption' => 'Photo caption',
                'chat' => ['id' => 100, 'type' => 'private'],
                'from' => ['id' => 1, 'username' => 'u', 'first_name' => 'U', 'is_bot' => false],
                'photo' => [['file_id' => 'abc', 'width' => 100, 'height' => 100]],
            ],
        ];

        $events = $this->normalizer->normalize($update, 'bot1');

        $this->assertCount(1, $events);
        $this->assertTrue($events[0]['message']['has_media']);
        $this->assertSame('photo', $events[0]['message']['media_type']);
        $this->assertSame('Photo caption', $events[0]['message']['text']);
    }

    public function testNormalizeMessageWithThreadId(): void
    {
        $update = [
            'update_id' => 900,
            'message' => [
                'message_id' => 60,
                'date' => 1700000000,
                'text' => 'Thread message',
                'chat' => ['id' => 100, 'type' => 'supergroup'],
                'from' => ['id' => 1, 'username' => 'u', 'first_name' => 'U', 'is_bot' => false],
                'message_thread_id' => 42,
                'is_topic_message' => true,
            ],
        ];

        $events = $this->normalizer->normalize($update, 'bot1');

        $this->assertCount(1, $events);
        $this->assertSame('42', $events[0]['chat']['thread_id']);
    }

    public function testNormalizeMessageWithReplyTo(): void
    {
        $update = [
            'update_id' => 1000,
            'message' => [
                'message_id' => 70,
                'date' => 1700000000,
                'text' => 'Reply message',
                'chat' => ['id' => 100, 'type' => 'private'],
                'from' => ['id' => 1, 'username' => 'u', 'first_name' => 'U', 'is_bot' => false],
                'reply_to_message' => ['message_id' => 65],
            ],
        ];

        $events = $this->normalizer->normalize($update, 'bot1');

        $this->assertCount(1, $events);
        $this->assertSame('65', $events[0]['message']['reply_to_message_id']);
    }

    public function testNormalizeForwardedMessage(): void
    {
        $update = [
            'update_id' => 1100,
            'message' => [
                'message_id' => 80,
                'date' => 1700000000,
                'text' => 'Forwarded',
                'chat' => ['id' => 100, 'type' => 'private'],
                'from' => ['id' => 1, 'username' => 'u', 'first_name' => 'U', 'is_bot' => false],
                'forward_from' => ['id' => 99, 'username' => 'origuser', 'first_name' => 'Orig'],
            ],
        ];

        $events = $this->normalizer->normalize($update, 'bot1');

        $this->assertCount(1, $events);
        $this->assertSame('origuser', $events[0]['message']['forward_from']);
    }

    public function testNormalizeForwardedFromChat(): void
    {
        $update = [
            'update_id' => 1101,
            'message' => [
                'message_id' => 81,
                'date' => 1700000000,
                'text' => 'Forwarded from channel',
                'chat' => ['id' => 100, 'type' => 'private'],
                'from' => ['id' => 1, 'username' => 'u', 'first_name' => 'U', 'is_bot' => false],
                'forward_from_chat' => ['id' => -1001, 'title' => 'Some Channel'],
            ],
        ];

        $events = $this->normalizer->normalize($update, 'bot1');

        $this->assertCount(1, $events);
        $this->assertSame('Some Channel', $events[0]['message']['forward_from']);
    }

    public function testNormalizeEventHasUniqueTraceAndRequestIds(): void
    {
        $update = [
            'update_id' => 1200,
            'message' => [
                'message_id' => 90,
                'date' => 1700000000,
                'text' => 'Test',
                'chat' => ['id' => 100, 'type' => 'private'],
                'from' => ['id' => 1, 'username' => 'u', 'first_name' => 'U', 'is_bot' => false],
            ],
        ];

        $events1 = $this->normalizer->normalize($update, 'bot1');
        $events2 = $this->normalizer->normalize($update, 'bot1');

        $this->assertNotSame($events1[0]['trace_id'], $events2[0]['trace_id']);
        $this->assertNotSame($events1[0]['request_id'], $events2[0]['request_id']);
    }
}
