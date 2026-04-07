import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const { password } = await request.json();

    if (!password) {
      return NextResponse.json(
        { message: 'Password is required' },
        { status: 400 }
      );
    }

    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
      console.error('Server missing ADMIN_PASSWORD environment variable.');
      return NextResponse.json(
        { message: 'Server configuration error' },
        { status: 500 }
      );
    }

    if (password === adminPassword) {
      return NextResponse.json(
        { message: 'Login successful' },
        { status: 200 }
      );
    } else {
      return NextResponse.json(
        { message: 'Unauthorized' },
        { status: 401 }
      );
    }
  } catch (error) {
    return NextResponse.json(
      { message: 'Invalid request' },
      { status: 400 }
    );
  }
}
