import json
import boto3
import os

bedrock = boto3.client('bedrock-runtime', region_name=os.environ.get('AWS_REGION', 'us-east-1'))
MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'

BATCH_SYSTEM_PROMPT = """You help people become aware of content they've published or commented on Instagram.

You will receive a numbered list of items. Analyze each one and return a JSON array with one object per item, in the same order. No additional text — only the JSON array.

Each object must follow this exact schema:
{"flagged": true/false, "severity": "high|medium|low|none", "categories": ["issue categories"], "reason": "brief explanation or null", "recommendation": "delete|review|keep"}

Flag content containing: personal sensitive information, aggressive language or threats, offensive/discriminatory content, compromising opinions, private information about third parties, or anything embarrassing in retrospect."""

CONVERSATION_SYSTEM_PROMPT = """You help people audit their Instagram direct message conversations for content they may want to delete.

You will receive a conversation window (numbered messages, each prefixed with the sender's name) and optionally a summary of previous context.

Return ONLY a JSON object — no additional text:
{
  "window_summary": "2-3 sentence summary of this window for continuity in the next one",
  "flagged": [
    {"index": 0, "severity": "high|medium|low", "categories": ["issue categories"], "reason": "brief explanation"}
  ]
}

Flag messages containing: personal sensitive information (address, phone, private data), aggressive language or threats, offensive/discriminatory content, private information about third parties, or anything embarrassing in retrospect.

Also flag unanswered contact patterns — flag the first message in the unanswered run:
- high: 5 or more consecutive messages from the same sender with no reply, or the sender dominates the whole conversation with minimal response from the other party
- medium: 3–4 consecutive unanswered messages, or repeated contact after a long silence
- low: 2 consecutive unanswered messages (double text)

If nothing is flagged, return an empty flagged array."""


def empty_analysis() -> dict:
    return {"flagged": False, "severity": "none", "categories": [], "reason": None, "recommendation": "keep"}


def strip_markdown(text: str) -> str:
    text = text.strip()
    if text.startswith('```'):
        text = text.split('\n', 1)[-1]
        text = text.rsplit('```', 1)[0]
    return text.strip()


def analyze_batch(items: list[dict]) -> list[dict]:
    numbered = '\n\n'.join(
        f'[{i}] Type: {item.get("type", "")}\nText: "{item.get("text", "")[:1000]}"'
        for i, item in enumerate(items)
    )

    response = bedrock.invoke_model(
        modelId=MODEL_ID,
        body=json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": max(len(items) * 200, 512),
            "system": [{"type": "text", "text": BATCH_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": f"Analyze these {len(items)} items and return a JSON array:\n\n{numbered}"}],
        }),
        contentType='application/json',
        accept='application/json',
    )

    result = json.loads(response['body'].read())
    return json.loads(strip_markdown(result['content'][0]['text']))


def analyze_conversation_window(messages: list[dict], window_summary: str | None) -> dict:
    numbered = '\n\n'.join(
        f'[{i}] {msg.get("sender", "?")} : {msg.get("text", "")[:800]}'
        for i, msg in enumerate(messages)
    )

    context = f'Previous context: {window_summary}\n\n' if window_summary else ''
    prompt = f'{context}Conversation window ({len(messages)} messages):\n\n{numbered}'

    response = bedrock.invoke_model(
        modelId=MODEL_ID,
        body=json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 2048,
            "system": [{"type": "text", "text": CONVERSATION_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": prompt}],
        }),
        contentType='application/json',
        accept='application/json',
    )

    result = json.loads(response['body'].read())
    return json.loads(strip_markdown(result['content'][0]['text']))


def handle_batch(items: list[dict]) -> dict:
    if not items or len(items) > 20:
        return build_response(400, {'error': 'Between 1 and 20 items per request'})

    try:
        analyses = analyze_batch(items)
        if not isinstance(analyses, list):
            raise ValueError('Expected a list')
    except Exception as e:
        print(f'analyze_batch error: {type(e).__name__}: {e}')
        analyses = []

    results = []
    for i, item in enumerate(items):
        analysis = analyses[i] if i < len(analyses) else empty_analysis()
        results.append({
            'id': item.get('id'),
            'type': item.get('type'),
            'group': item.get('group'),
            'text': item.get('text', '')[:200],
            'timestamp': item.get('timestamp'),
            'analysis': analysis,
        })

    return build_response(200, {'results': results})


def handle_conversation(messages: list[dict], window_summary: str | None) -> dict:
    if not messages or len(messages) > 1000:
        return build_response(400, {'error': 'Between 1 and 1000 messages per window'})

    try:
        conv_result = analyze_conversation_window(messages, window_summary)
    except Exception:
        return build_response(200, {'window_summary': window_summary or '', 'results': []})

    flagged_indices = {f['index'] for f in conv_result.get('flagged', [])}
    flag_map = {f['index']: f for f in conv_result.get('flagged', [])}

    # Only return flagged messages to minimize response payload
    results = []
    for i, msg in enumerate(messages):
        if i not in flagged_indices:
            continue
        flag = flag_map[i]
        results.append({
            'id': msg.get('id'),
            'type': msg.get('type', 'direct message'),
            'group': msg.get('group'),
            'text': msg.get('text', '')[:200],
            'timestamp': msg.get('timestamp'),
            'analysis': {
                'flagged': True,
                'severity': flag.get('severity', 'low'),
                'categories': flag.get('categories', []),
                'reason': flag.get('reason'),
                'recommendation': 'review',
            },
        })

    return build_response(200, {
        'window_summary': conv_result.get('window_summary', ''),
        'results': results,
    })


def handler(event, context):
    try:
        body = json.loads(event.get('body', '{}'))

        if 'conversation' in body:
            conv = body['conversation']
            return handle_conversation(
                conv.get('messages', []),
                conv.get('window_summary'),
            )

        return handle_batch(body.get('items', []))

    except Exception as e:
        return build_response(500, {'error': str(e)})


def build_response(status_code: int, body: dict) -> dict:
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        },
        'body': json.dumps(body, ensure_ascii=False),
    }
