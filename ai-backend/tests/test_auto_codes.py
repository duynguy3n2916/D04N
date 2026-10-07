import io

from app.database import SessionLocal
from app.models.learning import MediaVideo
from app.models.transcript import VideoTranscript
from tests.conftest import SRT, token


def _destination(client, teacher):
    response = client.post('/ai/courses', headers=teacher, json={'title': 'Khóa tự tạo', 'class_id': 'lop-a'})
    assert response.status_code == 200, response.text
    course = response.json()
    assert course['code'].startswith('KH-')
    tree = client.post(f"/ai/courses/{course['course_id']}/chapters", headers=teacher,
                       json={'title': 'Chương 1'}).json()
    chapter = tree['chapters'][0]['chapter_id']
    response = client.post(f'/ai/chapters/{chapter}/lessons', headers=teacher, json={'title': 'Bài 1'})
    assert response.status_code == 200, response.text
    lesson = response.json()['chapters'][0]['lessons'][0]
    assert lesson['code'].startswith('BH-')
    return course, lesson


def test_auto_course_and_lesson_codes_stay_stable(client, teacher):
    course, lesson = _destination(client, teacher)
    second, second_lesson = _destination(client, teacher)
    assert course['code'] != second['code'] and lesson['code'] != second_lesson['code']
    updated = client.patch(f"/ai/courses/{course['course_id']}", headers=teacher,
                           json={'title': 'Tên mới'}).json()
    assert updated['code'] == course['code']
    updated = client.patch(f"/ai/lessons/{lesson['lesson_id']}", headers=teacher,
                           json={'title': 'Bài đổi tên'}).json()
    assert updated['chapters'][0]['lessons'][0]['code'] == lesson['code']
    assert client.post('/ai/courses', headers=teacher, json={'title': '  '}).status_code == 400


def test_auto_video_attaches_and_transcript_inherits_scope(client, teacher, monkeypatch):
    from app.routers import media
    from app.services import transcription

    course, lesson = _destination(client, teacher)
    monkeypatch.setattr(media, '_duration', lambda _: 100.0)
    monkeypatch.setattr(transcription, 'transcribe_media', lambda *_: [
        {'start_time': 0, 'end_time': 10, 'text': 'Lời giảng của bài học được chọn'},
    ])
    response = client.post('/ai/media/videos', headers=teacher,
                           files={'file': ('Bài giảng.mp4', io.BytesIO(b'demo-video'), 'video/mp4')},
                           data={'target_lesson_id': lesson['lesson_id'], 'transcribe': 'true'})
    assert response.status_code == 201, response.text
    video = response.json()
    assert video['video_id'].startswith('VD-') and video['class_id'] == 'lop-a'
    tree = client.get(f"/ai/courses/{course['course_id']}", headers=teacher).json()
    item = tree['chapters'][0]['lessons'][0]['items'][0]
    assert item['video_id'] == video['video_id'] and item['type'] == 'video'
    assert item['title'] == 'Bài giảng.mp4'
    client.post(f"/ai/media/videos/{video['video_id']}/transcribe", headers=teacher)
    with SessionLocal() as db:
        transcript = db.query(VideoTranscript).filter_by(video_id=video['video_id'], is_active=True).one()
        assert transcript.lesson_id == lesson['code'] and transcript.course_id == course['code']
        assert transcript.class_id == 'lop-a'


def test_video_url_and_imported_subtitles_use_selected_lesson(client, teacher):
    course, lesson = _destination(client, teacher)
    response = client.post('/ai/media/videos/url', headers=teacher,
                           json={'title': 'Video ngoài', 'source_url': 'https://example.com/video.mp4',
                                 'target_lesson_id': lesson['lesson_id']})
    assert response.status_code == 200, response.text
    video = response.json()
    assert video['video_id'].startswith('VD-') and video['class_id'] == 'lop-a'
    response = client.post('/ai/videos/import-transcript', headers=teacher,
                           files={'file': ('subtitle.srt', io.BytesIO(SRT.encode()), 'text/plain')},
                           data={'video_id': video['video_id']})
    assert response.status_code == 200, response.text
    with SessionLocal() as db:
        transcript = db.query(VideoTranscript).filter_by(video_id=video['video_id'], is_active=True).one()
        assert transcript.lesson_id == lesson['code'] and transcript.course_id == course['code']
        assert transcript.class_id == 'lop-a'
    other = token(client, 'gv-auto-other', 'teacher', ['lop-b'])
    with SessionLocal() as db:
        before = db.query(MediaVideo).count()
    response = client.post('/ai/media/videos/url', headers=other,
                           json={'source_url': 'https://example.com/blocked.mp4', 'target_lesson_id': lesson['lesson_id']})
    assert response.status_code == 404
    response = client.post('/ai/videos/import-transcript', headers=other,
                           files={'file': ('subtitle.srt', io.BytesIO(SRT.encode()), 'text/plain')},
                           data={'video_id': video['video_id']})
    assert response.status_code == 403
    with SessionLocal() as db:
        assert db.query(MediaVideo).count() == before


def test_auto_video_can_stay_in_library(client, teacher):
    response = client.post('/ai/media/videos/url', headers=teacher,
                           json={'title': 'Thư viện', 'source_url': 'https://example.com/library.mp4'})
    assert response.status_code == 200 and response.json()['video_id'].startswith('VD-')
