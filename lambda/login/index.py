import json
import os

PASSWORD      = os.environ['PASSWORD']
SESSION_TOKEN = os.environ['SESSION_TOKEN']
ORIGIN        = os.environ['CLOUDFRONT_ORIGIN']

CORS = {
    'Access-Control-Allow-Origin':      ORIGIN,
    'Access-Control-Allow-Credentials': 'true',
    'Content-Type':                     'application/json',
}


def handler(event, context):
    body = json.loads(event.get('body') or '{}')

    if body.get('password') != PASSWORD:
        return {'statusCode': 401, 'headers': CORS, 'body': json.dumps({'error': 'Incorrect password'})}

    return {'statusCode': 200, 'headers': CORS, 'body': json.dumps({'token': SESSION_TOKEN})}
