use std::str;

fn main() {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| "解密失败:密钥不匹配或数据被篡改".to_string())?;
    String::from_utf8(plain).map_err(|e| format!("无效�?UTF-8: {}", e))
}
}
