import { ContactPicker } from '../../components/ContactPicker';
import { Screen } from '../../components/ui';

/** Màn "Tin nhắn mới": chọn người trong lớp theo thẻ lớp, vai trò và tên. */
export default function NewMessage() {
  return <Screen><ContactPicker replace /></Screen>;
}
