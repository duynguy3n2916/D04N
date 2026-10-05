# Giới thiệu lập trình hướng đối tượng

Lập trình hướng đối tượng (Object-Oriented Programming, viết tắt OOP) là một phương pháp lập trình tổ chức chương trình thành các đối tượng. Mỗi đối tượng kết hợp dữ liệu (thuộc tính) và hành vi (phương thức) liên quan đến nó. Thay vì viết chương trình như một chuỗi các hàm xử lý dữ liệu rời rạc, OOP mô hình hóa các thực thể trong bài toán, ví dụ sinh viên, tài khoản ngân hàng hay hóa đơn, thành các đối tượng có trạng thái riêng và có thể tương tác với nhau.

OOP giúp chương trình dễ mở rộng, dễ bảo trì và tái sử dụng mã nguồn. Các ngôn ngữ phổ biến hỗ trợ OOP gồm Java, C++, C# và Python.

# Lớp và đối tượng

Lớp (class) là bản thiết kế mô tả những thuộc tính và phương thức mà các đối tượng thuộc lớp đó sẽ có. Đối tượng (object) là một thể hiện cụ thể (instance) được tạo ra từ lớp. Có thể hình dung lớp giống như bản vẽ một ngôi nhà, còn đối tượng là ngôi nhà thật được xây theo bản vẽ đó. Từ một lớp có thể tạo ra nhiều đối tượng, mỗi đối tượng có giá trị thuộc tính riêng.

Trong Python, lớp được khai báo bằng từ khóa class. Phương thức đặc biệt __init__ là hàm khởi tạo (constructor), được gọi tự động khi tạo đối tượng mới để gán giá trị ban đầu cho các thuộc tính. Tham số self đại diện cho chính đối tượng đang được thao tác.

Ví dụ: lớp SinhVien có thuộc tính ho_ten, ma_sv, diem_tb và phương thức xep_loai(). Hai đối tượng sv1 và sv2 cùng thuộc lớp SinhVien nhưng có họ tên và điểm khác nhau.

# Tính đóng gói

Đóng gói (encapsulation) là việc gom dữ liệu và các phương thức xử lý dữ liệu đó vào trong cùng một lớp, đồng thời che giấu chi tiết bên trong, chỉ cho phép truy cập qua các phương thức được cung cấp. Mục đích của đóng gói là bảo vệ dữ liệu khỏi bị thay đổi tùy tiện từ bên ngoài và đảm bảo đối tượng luôn ở trạng thái hợp lệ.

Các ngôn ngữ như Java và C++ dùng phạm vi truy cập (access modifier) private, protected và public. Thuộc tính private chỉ được truy cập bên trong lớp. Trong Python, quy ước đặt tên thuộc tính bắt đầu bằng hai dấu gạch dưới (ví dụ __so_du) để hạn chế truy cập trực tiếp. Getter và setter là các phương thức dùng để đọc và cập nhật thuộc tính private một cách có kiểm soát; ví dụ phương thức rut_tien() của lớp TaiKhoan kiểm tra số dư trước khi trừ tiền.

# Tính kế thừa

Kế thừa (inheritance) cho phép một lớp con (subclass) tái sử dụng thuộc tính và phương thức của lớp cha (superclass), đồng thời bổ sung hoặc thay đổi hành vi riêng. Kế thừa thể hiện quan hệ "là một" (is-a): ví dụ lớp Cho kế thừa lớp DongVat vì chó là một động vật.

Lợi ích chính của kế thừa là tái sử dụng mã nguồn và xây dựng hệ thống phân cấp lớp rõ ràng. Trong Python, lớp con khai báo lớp cha trong cặp ngoặc: class Cho(DongVat). Hàm super() được dùng để gọi phương thức của lớp cha, thường gặp nhất là gọi super().__init__() trong hàm khởi tạo của lớp con.

Python hỗ trợ đa kế thừa (một lớp kế thừa từ nhiều lớp cha), còn Java chỉ cho phép đơn kế thừa với lớp nhưng một lớp có thể cài đặt nhiều interface.

# Tính đa hình

Đa hình (polymorphism) là khả năng cùng một lời gọi phương thức nhưng thực hiện hành vi khác nhau tùy theo đối tượng cụ thể. Ví dụ, lớp DongVat có phương thức keu(); lớp Cho ghi đè keu() để in "Gâu gâu", lớp Meo ghi đè để in "Meo meo". Khi duyệt một danh sách động vật và gọi keu() cho từng phần tử, mỗi đối tượng sẽ phát ra tiếng kêu riêng.

Có hai dạng đa hình thường gặp. Ghi đè phương thức (method overriding) là khi lớp con định nghĩa lại phương thức đã có ở lớp cha với cùng tên và tham số; đây là đa hình lúc chạy (runtime). Nạp chồng phương thức (method overloading) là khi trong cùng một lớp có nhiều phương thức cùng tên nhưng khác danh sách tham số; đây là đa hình lúc biên dịch, phổ biến trong Java và C++. Python không hỗ trợ nạp chồng theo kiểu Java mà thường dùng tham số mặc định thay thế.

# Tính trừu tượng

Trừu tượng (abstraction) là việc chỉ thể hiện những đặc điểm cần thiết của đối tượng và ẩn đi chi tiết cài đặt phức tạp. Người dùng lớp chỉ cần biết đối tượng làm được gì, không cần biết nó làm như thế nào.

Lớp trừu tượng (abstract class) là lớp không thể tạo đối tượng trực tiếp và có thể chứa phương thức trừu tượng (chỉ khai báo, không có phần thân). Lớp con bắt buộc phải cài đặt các phương thức trừu tượng đó. Trong Python, lớp trừu tượng được tạo bằng cách kế thừa ABC từ module abc và đánh dấu phương thức bằng decorator @abstractmethod. Interface trong Java là dạng trừu tượng hoàn toàn, chỉ định nghĩa các phương thức mà lớp cài đặt phải có.

# Bốn tính chất cơ bản của OOP

Lập trình hướng đối tượng có bốn tính chất cơ bản: đóng gói, kế thừa, đa hình và trừu tượng. Đóng gói bảo vệ dữ liệu; kế thừa giúp tái sử dụng mã; đa hình cho phép cùng một giao diện có nhiều cách thực hiện; trừu tượng giúp giảm độ phức tạp bằng cách ẩn chi tiết cài đặt.

# Quan hệ giữa các lớp

Ngoài kế thừa (quan hệ is-a), các lớp còn có quan hệ kết hợp "có một" (has-a). Kết tập (aggregation) là quan hệ mà đối tượng thành phần có thể tồn tại độc lập với đối tượng chứa nó, ví dụ lớp học có các sinh viên nhưng sinh viên vẫn tồn tại khi lớp học giải thể. Hợp thành (composition) là quan hệ chặt chẽ hơn: đối tượng thành phần bị hủy khi đối tượng chứa bị hủy, ví dụ ngôi nhà và các phòng của nó.

Nguyên tắc "ưu tiên hợp thành hơn kế thừa" (composition over inheritance) khuyên dùng hợp thành khi quan hệ giữa hai lớp không thực sự là "là một", giúp hệ thống linh hoạt và ít phụ thuộc hơn.

# So sánh với lập trình thủ tục

Lập trình thủ tục (procedural programming) tổ chức chương trình thành các hàm và dữ liệu tách rời, phù hợp với chương trình nhỏ, tuần tự. Lập trình hướng đối tượng gắn dữ liệu với hành vi trong đối tượng, phù hợp với hệ thống lớn, nhiều thực thể và cần mở rộng lâu dài. Nhược điểm của OOP là thiết kế ban đầu phức tạp hơn và có thể tốn tài nguyên hơn với chương trình đơn giản.
