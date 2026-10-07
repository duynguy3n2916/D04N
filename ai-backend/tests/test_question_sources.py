from app.database import SessionLocal
from app.models.documents import AIChunk, AIDocument
from app.services.embedding import embed_texts
from tests.conftest import token


def _lesson(client, teacher):
    course = client.post('/ai/courses', headers=teacher, json={'title': 'Chọn nguồn', 'class_id': 'lop-a'}).json()
    tree = client.post(f"/ai/courses/{course['course_id']}/chapters", headers=teacher,
                       json={'title': 'Chương'}).json()
    tree = client.post(f"/ai/chapters/{tree['chapters'][0]['chapter_id']}/lessons", headers=teacher,
                       json={'title': 'Bài chọn nguồn'}).json()
    return course, tree['chapters'][0]['lessons'][0]


def _slide(client, teacher, lesson, text):
    with SessionLocal() as db:
        doc = AIDocument(lesson_id=lesson['code'], class_id='lop-a', source_type='pdf', title=text,
                         status='ready', is_active=True)
        db.add(doc)
        db.flush()
        db.add(AIChunk(document_id=doc.id, content=text, chunk_index=0, page=1, embedding=embed_texts([text])[0]))
        db.commit()
        doc_id = str(doc.id)
    tree = client.post(f"/ai/lessons/{lesson['lesson_id']}/items", headers=teacher,
                       json={'type': 'slide', 'title': text, 'document_id': doc_id}).json()
    return doc_id, tree['chapters'][0]['lessons'][0]['items'][-1]['item_id']


def _sources(client, teacher, lesson):
    response = client.get('/ai/teacher/sources', headers=teacher, params={'lesson_id': lesson['code']})
    assert response.status_code == 200, response.text
    return response.json()


def test_detached_slide_is_excluded_from_generation_and_rag(client, teacher, fake_llm):
    _, lesson = _lesson(client, teacher)
    old_id, old_item = _slide(client, teacher, lesson, 'OLD_SLIDE_REMOVED: đóng gói che giấu dữ liệu của lớp.')
    current_id, _ = _slide(client, teacher, lesson, 'CURRENT_SLIDE: kế thừa giúp tái sử dụng phương thức.')
    assert {s['document_id'] for s in _sources(client, teacher, lesson)} == {old_id, current_id}
    assert client.delete(f'/ai/items/{old_item}', headers=teacher).status_code == 200
    assert {s['document_id'] for s in _sources(client, teacher, lesson)} == {current_id}
    response = client.post('/ai/teacher/generate-quiz', headers=teacher,
                           json={'lesson_id': lesson['code'], 'count': 1})
    assert response.status_code == 200, response.text
    assert {s['document_id'] for s in response.json()['sources']} == {current_id}
    assert 'OLD_SLIDE_REMOVED' not in fake_llm.calls[-1]['user']
    response = client.post('/ai/teacher/generate-quiz', headers=teacher,
                           json={'lesson_id': lesson['code'], 'document_ids': [old_id], 'count': 1})
    assert response.status_code == 400 and response.json()['error']['code'] == 'INVALID_SOURCE'
    response = client.post('/ai/chat', headers=teacher,
                           json={'lesson_id': lesson['code'], 'question': 'Đóng gói là gì?', 'focus_document_id': old_id})
    assert response.status_code == 200
    assert old_id not in {s.get('document_id') for s in response.json()['sources']}


def test_explicit_sources_only_use_selected_content(client, teacher, fake_llm):
    _, lesson = _lesson(client, teacher)
    slide_id, _ = _slide(client, teacher, lesson, 'ONLY_CHOSEN_SLIDE: lớp và đối tượng trong OOP.')
    client.post(f"/ai/lessons/{lesson['lesson_id']}/items", headers=teacher,
                json={'type': 'reading', 'title': 'Bài đọc riêng',
                      'content_md': 'UNSELECTED_READING: Kế thừa cho phép lớp con dùng phương thức của lớp cha.'})
    available = _sources(client, teacher, lesson)
    assert {s['kind'] for s in available} == {'slide', 'reading'}
    response = client.post('/ai/teacher/generate-quiz', headers=teacher,
                           json={'lesson_id': lesson['code'], 'document_ids': [slide_id], 'count': 1})
    assert response.status_code == 200, response.text
    assert {s['document_id'] for s in response.json()['sources']} == {slide_id}
    assert 'ONLY_CHOSEN_SLIDE' in fake_llm.calls[-1]['user']
    assert 'UNSELECTED_READING' not in fake_llm.calls[-1]['user']
    assert client.post('/ai/teacher/generate-quiz', headers=teacher,
                       json={'lesson_id': lesson['code'], 'document_ids': []}).status_code == 422
    other = token(client, 'gv-sources-other', 'teacher', ['lop-b'])
    assert client.get('/ai/teacher/sources', headers=other, params={'lesson_id': lesson['code']}).status_code == 404
    assert client.post('/ai/teacher/generate-quiz', headers=other,
                       json={'lesson_id': lesson['code'], 'document_ids': [slide_id]}).status_code == 400


def test_shared_slide_stays_available_until_last_item_is_removed(client, teacher):
    _, lesson = _lesson(client, teacher)
    slide_id, item_id = _slide(client, teacher, lesson, 'Slide dùng ở hai mục học.')
    tree = client.post(f"/ai/lessons/{lesson['lesson_id']}/items", headers=teacher,
                       json={'type': 'slide', 'title': 'Mục dùng lại slide', 'document_id': slide_id}).json()
    other_item = tree['chapters'][0]['lessons'][0]['items'][-1]['item_id']
    client.delete(f'/ai/items/{item_id}', headers=teacher)
    assert {s['document_id'] for s in _sources(client, teacher, lesson)} == {slide_id}
    client.delete(f'/ai/items/{other_item}', headers=teacher)
    assert _sources(client, teacher, lesson) == []
